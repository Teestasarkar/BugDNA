/**
 * Environment configuration.
 *
 * Every environment variable the API reads is declared, coerced and validated
 * exactly once, here. Nothing else in the codebase touches `process.env`, so
 * a missing or malformed value fails loudly at boot rather than surfacing as a
 * confusing `undefined` deep inside a request.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isValidQueueIdentifier } from "../queue/queue-names";

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------
// In Docker/production the process is handed its environment directly, so this
// is a no-op. It exists for native local development.
loadDotEnvFiles();

function loadDotEnvFiles(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../.env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) continue; // real env wins
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rejects colons. BullMQ uses `:` as its Redis key separator and throws from
 * the Queue/Worker constructor if a name contains one, which surfaces as a
 * crash at boot rather than a configuration error.
 */
const noColon = (inner: z.ZodDefault<z.ZodString>, name: string) =>
  inner.refine(isValidQueueIdentifier, {
    message:
      `${name} cannot contain ":" — BullMQ uses it as a Redis key separator. ` +
      `Put namespacing in QUEUE_PREFIX instead.`,
  });

/** Comma-separated list -> trimmed, non-empty string array. */
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .default(String(fallback) as "true" | "false")
    .transform((v) => v === "true" || v === "1");

const int = (fallback: number, min?: number, max?: number) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema.default(fallback);
};

const HEX64 = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  API_PORT: int(4000, 1, 65535),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_FORMAT: z.enum(["pretty", "json"]).default("json"),

  // --- data stores ---
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // --- http ---
  CORS_ORIGINS: csv("http://localhost:3000"),
  TRUST_PROXY: bool(false),

  // --- session / crypto ---
  SESSION_SECRET: z.string().default(""),
  SESSION_TTL_HOURS: int(168, 1, 24 * 90),
  COOKIE_NAME: z.string().default("bugdna_session"),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().default(""),
  TOKEN_ENCRYPTION_KEY: z.string().default(""),

  // --- GitHub ---
  GITHUB_MODE: z.enum(["live", "mock"]).default("live"),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  GITHUB_CALLBACK_URL: z
    .string()
    .default("http://localhost:4000/api/v1/auth/github/callback"),
  GITHUB_OAUTH_SCOPES: csv("read:user,user:email,repo"),
  GITHUB_API_BASE: z.string().url().default("https://api.github.com"),
  GITHUB_SYSTEM_TOKEN: z.string().default(""),
  GITHUB_MAX_FILES_PER_PR: int(300, 1, 3000),
  GITHUB_MAX_PATCH_BYTES: int(120_000, 1_000, 5_000_000),
  GITHUB_REQUEST_TIMEOUT_MS: int(15_000, 1_000, 120_000),

  // --- ML service ---
  ML_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  ML_SERVICE_TOKEN: z.string().default(""),
  ML_REQUEST_TIMEOUT_MS: int(20_000, 1_000, 120_000),
  ML_MAX_RETRIES: int(2, 0, 10),

  // --- analysis pipeline ---
  /**
   * Queue name and Redis key namespace.
   *
   * BullMQ builds its Redis keys as `{prefix}:{queueName}:{...}`, so a colon in
   * either value is rejected by the library — `Queue name cannot contain :`,
   * thrown from the constructor at boot. Namespacing goes in QUEUE_PREFIX, not
   * in the name. Validated here so a bad value is a startup error with an
   * explanation rather than a BullMQ stack trace.
   */
  ANALYSIS_QUEUE_NAME: noColon(z.string().default("analysis"), "ANALYSIS_QUEUE_NAME"),
  QUEUE_PREFIX: noColon(z.string().default("bugdna"), "QUEUE_PREFIX"),
  ANALYSIS_CONCURRENCY: int(4, 1, 64),
  ANALYSIS_JOB_ATTEMPTS: int(3, 1, 10),
  ANALYSIS_JOB_BACKOFF_MS: int(4_000, 100, 120_000),
  ANALYSIS_TIMEOUT_MS: int(120_000, 5_000, 900_000),
  HIGH_RISK_NOTIFY_THRESHOLD: int(70, 0, 100),

  // --- cache TTLs (seconds) ---
  CACHE_TTL_REPOS: int(300, 0, 86_400),
  CACHE_TTL_PULLS: int(120, 0, 86_400),
  CACHE_TTL_DIFF: int(900, 0, 86_400),
  CACHE_TTL_ANALYTICS: int(180, 0, 86_400),

  // --- rate limiting ---
  RATE_LIMIT_WINDOW_MS: int(60_000, 1_000, 3_600_000),
  RATE_LIMIT_MAX: int(300, 1, 100_000),
  RATE_LIMIT_ANALYSIS_MAX: int(30, 1, 10_000),

  // --- seed / demo ---
  SEED_DEMO_EMAIL: z.string().default("demo@bugdna.dev"),
  SEED_DEMO_LOGIN: z.string().default("bugdna-demo"),
  /**
   * Allows POST /auth/demo to sign in as the seeded demo account without GitHub.
   *
   * Safe by construction rather than by trust: the demo user owns only the
   * synthetic repositories created by `npm run seed`, and the tenancy predicate
   * means it can never read another account's data. Set to false to remove the
   * endpoint entirely.
   */
  ENABLE_DEMO_LOGIN: bool(true),

  /**
   * Run the analysis worker inside the API process.
   *
   * The worker normally runs as its own process — see docs/Architecture.md for
   * why that separation is right at any real scale. But free hosting tiers
   * (Render, Koyeb, Fly) only give away *web* services; a dedicated background
   * worker is a paid product everywhere.
   *
   * So this flag exists to collapse the two onto one dyno for small or demo
   * deployments. It is an honest trade, not a hidden default: a wedged analysis
   * can now affect API latency, and the two can no longer scale independently.
   * Leave it false wherever a separate worker process is affordable.
   */
  RUN_WORKER_IN_API: bool(false),
});

export type RawEnv = z.infer<typeof schema>;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function parseEnv(): RawEnv {
  // Every PaaS (Render, Railway, Fly, Heroku, Cloud Run) injects the port it
  // wants the process to listen on as `PORT`, and routes to nothing else. An
  // explicit API_PORT still wins, so Docker Compose and local development are
  // unaffected — this only fills in the blank a platform left.
  const source: NodeJS.ProcessEnv = { ...process.env };
  if (source.API_PORT === undefined && source.PORT !== undefined) {
    source.API_PORT = source.PORT;
  }

  const result = schema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Intentionally console.error: the logger itself depends on this module.
    console.error(
      `\nInvalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env and fill in the required values.\n`,
    );
    process.exit(1);
  }

  return result.data;
}

const raw = parseEnv();
const isProd = raw.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------
// Production demands real secrets. Development derives a deterministic stand-in
// so that `cp .env.example .env && docker compose up` works on a fresh clone
// without a setup ritual — but it says so, loudly, every boot.

const devWarnings: string[] = [];

function resolveSessionSecret(): string {
  const provided = raw.SESSION_SECRET.trim();
  const usable = provided && !provided.startsWith("CHANGE_ME") && provided.length >= 32;

  if (usable) return provided;

  if (isProd) {
    console.error(
      "\nSESSION_SECRET must be set to a random string of at least 32 characters " +
        "in production.\n  generate:  openssl rand -hex 48\n",
    );
    process.exit(1);
  }

  devWarnings.push(
    "SESSION_SECRET is unset or still a placeholder — using an insecure " +
      "development-only value. Sessions will not survive a secret change.",
  );
  return crypto
    .createHash("sha256")
    .update("bugdna-insecure-dev-session-secret")
    .digest("hex");
}

function resolveTokenEncryptionKey(): Buffer {
  const provided = raw.TOKEN_ENCRYPTION_KEY.trim();

  if (HEX64.test(provided)) return Buffer.from(provided, "hex");

  if (isProd) {
    console.error(
      "\nTOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) " +
        "in production.\n  generate:  openssl rand -hex 32\n",
    );
    process.exit(1);
  }

  devWarnings.push(
    "TOKEN_ENCRYPTION_KEY is unset or malformed — using an insecure " +
      "development-only key. Stored GitHub tokens will be unreadable if it changes.",
  );
  return crypto
    .createHash("sha256")
    .update("bugdna-insecure-dev-token-encryption-key")
    .digest();
}

const sessionSecret = resolveSessionSecret();
const tokenEncryptionKey = resolveTokenEncryptionKey();

// GitHub OAuth is only strictly required in `live` mode.
const githubConfigured =
  Boolean(raw.GITHUB_CLIENT_ID.trim()) && Boolean(raw.GITHUB_CLIENT_SECRET.trim());

if (raw.GITHUB_MODE === "live" && !githubConfigured) {
  devWarnings.push(
    "GITHUB_MODE=live but GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are empty. " +
      "GitHub sign-in will return a 503 until they are set. " +
      "Set GITHUB_MODE=mock to run entirely on fixtures.",
  );
}

if (isProd && raw.GITHUB_MODE === "live" && !githubConfigured) {
  console.error(
    "\nGITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required when " +
      "GITHUB_MODE=live in production.\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Public config object
// ---------------------------------------------------------------------------

export const env = {
  ...raw,

  isProd,
  isDev: raw.NODE_ENV === "development",
  isTest: raw.NODE_ENV === "test",

  /** Resolved session signing secret (never the raw placeholder). */
  sessionSecret,
  /** 32-byte AES-256-GCM key for GitHub token encryption. */
  tokenEncryptionKey,
  /** True when a real GitHub OAuth app is configured. */
  githubConfigured,

  /** Warnings to emit once the logger exists. */
  startupWarnings: devWarnings as readonly string[],

  /** Base path all versioned routes hang off. */
  apiPrefix: "/api/v1",
} as const;

export type Env = typeof env;
