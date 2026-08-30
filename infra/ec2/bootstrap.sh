#!/usr/bin/env bash
# =============================================================================
# BugDNA — EC2 instance bootstrap
# =============================================================================
# Run ONCE on a fresh Amazon Linux 2023 or Ubuntu 22.04+ instance. Installs
# Docker, prepares the application directory, and configures the things that
# make a small instance survive: swap, log rotation and a firewall.
#
#   curl -fsSL https://raw.githubusercontent.com/Teestasarkar/BugDNA/main/infra/ec2/bootstrap.sh | sudo bash
#
# or, having cloned the repo:
#
#   sudo bash infra/ec2/bootstrap.sh
#
# Recommended instance: t3.small (2 vCPU, 2GB). t3.micro (1GB) works with the
# swap this script configures, but the risk service is tight at 1GB.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bugdna}"
APP_USER="${APP_USER:-bugdna}"
REPO_URL="${REPO_URL:-https://github.com/Teestasarkar/BugDNA.git}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (use sudo)." >&2
  exit 1
fi

# --- detect the distribution -------------------------------------------------
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="$ID"
else
  echo "Cannot determine the distribution (/etc/os-release missing)." >&2
  exit 1
fi

log "Detected distribution: $DISTRO ${VERSION_ID:-}"

# --- packages ----------------------------------------------------------------
log "Installing Docker and dependencies"

case "$DISTRO" in
  amzn)
    dnf update -y
    dnf install -y docker git curl jq
    # Amazon Linux ships the compose plugin separately.
    mkdir -p /usr/local/lib/docker/cli-plugins
    COMPOSE_VERSION="v2.31.0"
    curl -fsSL \
      "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    ;;

  ubuntu | debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg git jq ufw

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${DISTRO}/gpg" \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${DISTRO} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
    ;;

  *)
    echo "Unsupported distribution: $DISTRO" >&2
    exit 1
    ;;
esac

systemctl enable --now docker
docker --version
docker compose version

# --- swap --------------------------------------------------------------------
# Not optional on a 1-2GB instance. Without it, the Node build steps and the
# risk service's first model load will be OOM-killed.
if ! swapon --show | grep -q '/swapfile'; then
  log "Creating a 2GB swap file"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer keeping pages in RAM; swap is insurance, not a working store.
  sysctl -w vm.swappiness=10
  grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  log "Swap already configured"
fi

# --- application user --------------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating the $APP_USER user"
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi
usermod -aG docker "$APP_USER"

# Let the default login user drive docker without sudo.
for candidate in ec2-user ubuntu admin; do
  if id -u "$candidate" >/dev/null 2>&1; then
    usermod -aG docker "$candidate"
    log "Added $candidate to the docker group"
  fi
done

# --- application directory ---------------------------------------------------
log "Preparing $APP_DIR"
mkdir -p "$APP_DIR" "$APP_DIR/backups"

if [[ -d "$APP_DIR/.git" ]]; then
  log "Repository already present; fetching"
  git -C "$APP_DIR" fetch --all --prune
else
  log "Cloning $REPO_URL"
  git clone "$REPO_URL" "$APP_DIR" || warn "clone failed — copy the repo manually"
fi

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# --- docker log rotation -----------------------------------------------------
# The compose files set per-service limits, but this catches anything started
# outside compose and would otherwise fill the root volume.
log "Configuring Docker log rotation"
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
JSON
systemctl restart docker

# --- firewall ----------------------------------------------------------------
# Defence in depth behind the EC2 security group. Only SSH and HTTP(S) are open;
# Postgres, Redis, the API and the risk service are never exposed.
if command -v ufw >/dev/null 2>&1; then
  log "Configuring ufw"
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp comment 'SSH'
  ufw allow 80/tcp comment 'HTTP'
  ufw allow 443/tcp comment 'HTTPS'
  ufw --force enable
  ufw status verbose
else
  warn "ufw is not available; rely on the EC2 security group. Open only 22, 80 and 443."
fi

# --- unattended security updates --------------------------------------------
case "$DISTRO" in
  ubuntu | debian)
    apt-get install -y unattended-upgrades
    dpkg-reconfigure -f noninteractive unattended-upgrades || true
    ;;
  amzn)
    dnf install -y dnf-automatic || true
    systemctl enable --now dnf-automatic.timer || true
    ;;
esac

# --- nightly backup ----------------------------------------------------------
if [[ -f "$APP_DIR/infra/ec2/backup.sh" ]]; then
  log "Scheduling the nightly database backup"
  chmod +x "$APP_DIR/infra/ec2/backup.sh"
  cat > /etc/cron.d/bugdna-backup <<CRON
# BugDNA — nightly pg_dump at 03:15 UTC
15 3 * * * $APP_USER cd $APP_DIR && ./infra/ec2/backup.sh >> /var/log/bugdna-backup.log 2>&1
CRON
fi

# --- done --------------------------------------------------------------------
cat <<DONE

============================================================
 Bootstrap complete
============================================================

 Next steps:

   1. Create the production environment file:

        cd $APP_DIR
        cp .env.example .env
        ./infra/ec2/generate-secrets.sh        # writes real secrets into .env
        \$EDITOR .env                           # set APP_URL, API_URL, GitHub OAuth

   2. Authenticate to the container registry (needed to pull images):

        echo \$GITHUB_TOKEN | docker login ghcr.io -u Teestasarkar --password-stdin

   3. Deploy:

        ./infra/ec2/deploy.sh

   4. Optional — TLS for a real domain:

        sudo ./infra/ec2/setup-tls.sh bugdna.example.com you@example.com

 The instance's public address:
   http://$(curl -fsS --max-time 3 http://169.254.169.254/latest/meta-data/public-hostname 2>/dev/null || echo '<public-dns>')

============================================================

DONE
