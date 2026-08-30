/**
 * Structured logging.
 *
 * JSON by default so logs are machine-parseable wherever they land (Docker
 * stdout -> CloudWatch / journald). `LOG_FORMAT=pretty` switches to
 * human-readable output for local development.
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

export const logger =
  env.LOG_FORMAT === "pretty"
    ? pino({
        ...options,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,service,env",
            singleLine: false,
          },
        },
      })
    : pino(options);

/** Child logger bound to a subsystem, e.g. `scoped("github")`. */
export function scoped(component: string) {
  return logger.child({ component });
}

export type Logger = typeof logger;
