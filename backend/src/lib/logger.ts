/**
 * Structured logging.
 *
 * JSON by default so logs are machine-parseable wherever they land (Docker
 * stdout -> CloudWatch / journald). `LOG_FORMAT=pretty` switches to
 * human-readable output for local development.
 *
 * Pretty printing is a *preference*, and a preference must never stop the
 * process from starting. `pino-pretty` is a devDependency and is pruned from
 * the production image, so the transport is only requested once it is known to
 * resolve — see prettyTransport() below.
 *
 * Anything that could carry a credential is redacted at the serialiser level,
 * so a careless `logger.info({ req })` cannot leak a token.
 */
import pino, { type LoggerOptions } from "pino";
import { env } from "../config/env";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "*.accessToken",
  "*.access_token",
  "*.refreshToken",
  "*.clientSecret",
  "*.client_secret",
  "*.password",
  "*.token",
  "accessToken",
  "accessTokenCipher",
  "TOKEN_ENCRYPTION_KEY",
  "SESSION_SECRET",
  "GITHUB_CLIENT_SECRET",
  "ML_SERVICE_TOKEN",
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: {
    service: "bugdna-api",
    env: env.NODE_ENV,
  },
  redact: { paths: redactPaths, censor: "[redacted]" },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * The pino-pretty transport, or undefined if it is not installed.
 *
 * pino resolves a transport target in a worker thread and throws
 * `unable to determine transport target` if it is missing. That throw happens
 * at module-import time, before any logger exists to report it — so the only
 * output is a bare stack trace and the container restarts forever. Checking
 * first turns a crash loop into one warning and correct JSON logs.
 */
function prettyTransport(): LoggerOptions["transport"] | undefined {
  try {
    require.resolve("pino-pretty");
  } catch {
    // Deliberately console.warn: the logger being constructed is not usable yet.
    console.warn(
      "LOG_FORMAT=pretty but pino-pretty is not installed (it is a " +
        "devDependency, pruned from production images). Falling back to JSON. " +
        "Set LOG_FORMAT=json to silence this.",
    );
    return undefined;
  }

  return {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname,service,env",
      singleLine: false,
    },
  };
}

const transport = env.LOG_FORMAT === "pretty" ? prettyTransport() : undefined;

export const logger = transport ? pino({ ...options, transport }) : pino(options);

/** Child logger bound to a subsystem, e.g. `scoped("github")`. */
export function scoped(component: string) {
  return logger.child({ component });
}

export type Logger = typeof logger;
