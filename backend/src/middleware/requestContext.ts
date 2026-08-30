/**
 * Request correlation + HTTP logging.
 *
 * Every request gets an id (reusing an inbound `x-request-id` when a proxy
 * supplied one, so traces survive the Nginx hop). The id is echoed in the
 * response header and attached to every log line for that request, which is
 * what makes a production log searchable.
 */
import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import pinoHttp from "pino-http";
import { logger } from "../lib/logger";
import { unauthenticated } from "../lib/errors";

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header("x-request-id");
  req.id = inbound && /^[\w-]{1,128}$/.test(inbound) ? inbound : crypto.randomUUID();
  req.startedAt = Date.now();

  res.setHeader("x-request-id", req.id);

  // Checked accessor so controllers never need `req.auth!`.
  req.user = function user() {
    if (!this.auth) throw unauthenticated();
    return this.auth;
  };

  next();
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).id,
  // Health checks are high-frequency and uninteresting; keep them out of the log
  // unless something actually failed.
  autoLogging: {
    ignore: (req) => {
      const url = req.url ?? "";
      return url === "/health" || url === "/healthz" || url === "/api/v1/system/health";
    },
  },
  customLogLevel: (_req, res, err) => {
    if (err) return "error";
    if (res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        // Deliberately omit headers wholesale — the redact list in logger.ts is a
        // backstop, not the primary defence.
        userAgent: req.headers?.["user-agent"],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
