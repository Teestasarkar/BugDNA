/**
 * Terminal error handling.
 *
 * The contract every client can rely on: a non-2xx response always has the
 * shape
 *
 *     { "error": { "code", "message", "status", "retryable", details? } }
 *
 * `code` is stable and machine-readable; `message` is safe to display. Genuine
 * bugs are logged with their stack and returned as a generic 500 — internal
 * detail never crosses the wire.
 */
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, errorMessage, isAppError, notFound } from "../lib/errors";
import { mapPrismaError } from "../lib/prisma";
import { logger } from "../lib/logger";
import { HttpNetworkError, HttpTimeoutError } from "../lib/http";
import { env } from "../config/env";

/** 404 handler for unmatched routes. Registered after all routers. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`Route ${req.method} ${req.path}`));
}

/** Convert anything thrown into an AppError. */
function normalize(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (err instanceof ZodError) {
    return new AppError(400, "Request validation failed", {
      code: "VALIDATION_FAILED",
      retryable: false,
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    });
  }

  const prismaError = mapPrismaError(err);
  if (prismaError) return prismaError;

  if (err instanceof HttpTimeoutError) {
    return new AppError(504, "An upstream service timed out", {
      code: "INTERNAL",
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof HttpNetworkError) {
    return new AppError(502, "An upstream service is unreachable", {
      code: "INTERNAL",
      retryable: true,
      cause: err,
    });
  }

  // Express 5 surfaces malformed JSON bodies as a SyntaxError with `.body`.
  if (
    err instanceof SyntaxError &&
    "body" in err &&
    (err as SyntaxError & { status?: number }).status === 400
  ) {
    return new AppError(400, "Request body is not valid JSON", {
      code: "BAD_REQUEST",
      retryable: false,
    });
  }

  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: string }).type === "entity.too.large"
  ) {
    return new AppError(413, "Request body is too large", {
      code: "PAYLOAD_TOO_LARGE",
      retryable: false,
    });
  }

  return new AppError(500, "An unexpected error occurred", {
    code: "INTERNAL",
    retryable: true,
    cause: err,
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Delegate to Express if the response has already started streaming.
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = normalize(err);
  const log = req.log ?? logger;

  const logPayload = {
    requestId: req.id,
    method: req.method,
    path: req.path,
    status: appError.status,
    code: appError.code,
    userId: req.auth?.userId,
    durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
    ...appError.context,
  };

  if (appError.status >= 500) {
    // Unexpected: log the original throw with its stack.
    const cause = (appError.cause ?? err) as Error | undefined;
    log.error(
      { ...logPayload, err: cause, causeMessage: errorMessage(cause) },
      `unhandled error: ${appError.message}`,
    );
  } else {
    log.warn(logPayload, `request rejected: ${appError.message}`);
  }

  if (appError.retryAfterSeconds !== undefined) {
    res.setHeader("retry-after", String(appError.retryAfterSeconds));
  }

  const body = appError.toJSON();

  // In development, include the underlying cause to shorten the debug loop.
  if (!env.isProd && appError.status >= 500) {
    const cause = (appError.cause ?? err) as Error | undefined;
    (body.error as Record<string, unknown>).debug = {
      cause: errorMessage(cause),
      stack: cause?.stack?.split("\n").slice(0, 8),
    };
  }

  res.status(appError.status).json({ ...body, requestId: req.id });
}

/**
 * Wrap an async handler so rejections reach the error middleware.
 *
 * Express 5 forwards rejected promises automatically, so this is belt-and-braces
 * — but it also gives every controller a single, obvious shape.
 */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(handler: T) {
  return function wrapped(req: Request, res: Response, next: NextFunction): void {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
