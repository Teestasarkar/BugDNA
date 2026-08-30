#!/usr/bin/env bash
# =============================================================================
# Obtain and install a Let's Encrypt certificate
# =============================================================================
#   sudo ./infra/ec2/setup-tls.sh bugdna.example.com you@example.com
#
# Point an A record at this instance first. Certbot verifies domain ownership by
# fetching a file over HTTP, so DNS must already resolve here or issuance fails.
#
# Uses the webroot challenge rather than certbot's nginx plugin: Nginx runs in a
# container here, so the plugin cannot edit its config or reload it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

DOMAIN="${1:-}"
EMAIL="${2:-}"
COMPOSE_FILE="docker-compose.prod.yml"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "usage: sudo $0 <domain> <email>" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (certificates are written to /etc/letsencrypt)" >&2
  exit 1
fi

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

# --- confirm DNS points here ------------------------------------------------
log "Checking that ${DOMAIN} resolves to this instance"
PUBLIC_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || echo '')"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')"

if [[ -n "$PUBLIC_IP" && -n "$RESOLVED" && "$PUBLIC_IP" != "$RESOLVED" ]]; then
  echo "  warning: ${DOMAIN} resolves to ${RESOLVED}, this instance is ${PUBLIC_IP}"
  echo "  Certbot will fail unless DNS has propagated. Continue anyway? [y/N]"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || exit 1
else
  echo "  ok: ${RESOLVED:-unresolved} / ${PUBLIC_IP:-unknown}"
fi

# --- install certbot --------------------------------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  log "Installing certbot"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot
  else
    apt-get update -y && apt-get install -y certbot
  fi
fi

# --- issue ------------------------------------------------------------------
# The compose file mounts the `certbot-webroot` volume into Nginx read-only at
# /var/www/certbot, and the site config serves /.well-known from it.
WEBROOT="/var/lib/docker/volumes/bugdna_certbot-webroot/_data"
mkdir -p "$WEBROOT"

log "Requesting a certificate for ${DOMAIN}"
certbot certonly \
  --webroot -w "$WEBROOT" \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos --no-eff-email \
  --non-interactive \
  --keep-until-expiring

# --- install into the Nginx cert directory ----------------------------------
log "Installing the certificate for Nginx"
CERT_DIR="./infra/nginx/certs"
mkdir -p "$CERT_DIR"
cp -L "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${CERT_DIR}/fullchain.pem"
cp -L "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" "${CERT_DIR}/privkey.pem"
chmod 600 "${CERT_DIR}/privkey.pem"

# --- add the TLS server block ----------------------------------------------
TLS_CONF="./infra/nginx/conf.d/tls.conf.template"
if [[ ! -f "$TLS_CONF" ]]; then
  log "Writing the TLS server block"
  cat > "$TLS_CONF" <<'NGINX'
# Added by infra/ec2/setup-tls.sh. Redirects HTTP to HTTPS and terminates TLS.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name ${BUGDNA_SERVER_NAME};

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    # Modern profile: TLS 1.2+ only, no weak ciphers.
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    include /etc/nginx/snippets/bugdna-locations.conf;
}
NGINX
  echo "  wrote ${TLS_CONF}"
  echo
  echo "  NOTE: the location blocks live in the HTTP server. To share them, move"
  echo "  them into infra/nginx/snippets/bugdna-locations.conf and include that"
  echo "  file from both server blocks. See docs/DEPLOYMENT.md."
fi

# --- renewal ---------------------------------------------------------------
log "Installing the renewal hook"
cat > /etc/cron.d/bugdna-certbot <<CRON
# Renew twice daily (certbot no-ops until within 30 days of expiry), then copy
# the new certificate in and reload Nginx.
0 3,15 * * * root certbot renew --quiet --webroot -w ${WEBROOT} --deploy-hook '$(pwd)/infra/ec2/reload-tls.sh ${DOMAIN}'
CRON

cat > ./infra/ec2/reload-tls.sh <<'RELOAD'
#!/usr/bin/env bash
# Copy a renewed certificate into the Nginx mount and reload without downtime.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DOMAIN="${1:?domain required}"
cp -L "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ./infra/nginx/certs/fullchain.pem
cp -L "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ./infra/nginx/certs/privkey.pem
chmod 600 ./infra/nginx/certs/privkey.pem
docker compose -f docker-compose.prod.yml exec -T nginx nginx -s reload
RELOAD
chmod +x ./infra/ec2/reload-tls.sh

log "Restarting Nginx"
docker compose -f "$COMPOSE_FILE" up -d nginx

cat <<DONE

============================================================
 TLS configured for ${DOMAIN}
============================================================

 Now update .env and redeploy:

   APP_URL=https://${DOMAIN}
   API_URL=https://${DOMAIN}
   CORS_ORIGINS=https://${DOMAIN}
   NEXT_PUBLIC_API_URL=https://${DOMAIN}
   NEXT_PUBLIC_WS_URL=https://${DOMAIN}
   GITHUB_CALLBACK_URL=https://${DOMAIN}/api/v1/auth/github/callback
   BUGDNA_SERVER_NAME=${DOMAIN}
   COOKIE_SECURE=true

   ./infra/ec2/deploy.sh

 Then update the callback URL on the GitHub OAuth App to match.

============================================================

DONE
