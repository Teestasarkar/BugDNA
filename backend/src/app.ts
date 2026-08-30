/**
 * Express application.
 *
 * Middleware order is load-bearing and worth reading top to bottom:
 *
 *  1. `trust proxy`      — so `req.ip` is the client, not Nginx, which the rate
 *                          limiter and audit logs depend on
 *  2. request context    — assigns the correlation id everything else logs
 *  3. security headers   — before anything can respond
 *  4. CORS               — before the body is parsed, so a rejected origin costs
 *                          nothing
 *  5. body parsing       — with a size cap
 *  6. logging            — after the id exists, before the routes
 *  7. rate limiting      — after auth is *available* but before handlers, so
 *                          limits can key on user id
 *  8. routes
 *  9. 404, then the error handler — last, always
 */
import express, { type Application } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { installBigIntSerialization } from "./lib/serialize";
import { httpLogger, requestContext } from "./middleware/requestContext";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { generalLimiter } from "./middleware/rateLimit";
import { optionalAuth } from "./middleware/auth";
import apiRoutes from "./routes";

// Teach BigInt to serialise before any route can return a GitHub id.
installBigIntSerialization();

export function createApp(): Application {
  const app = express();

  // ---- 1. proxy awareness -------------------------------------------------
  // Behind Nginx/ELB the socket address is the proxy. Without this, every
  // request appears to come from one IP and IP-based limits become global.
  if (env.TRUST_PROXY) app.set("trust proxy", 1);

  app.disable("x-powered-by");

  // ---- 2. request context -------------------------------------------------
  app.use(requestContext);

  // ---- 3. security headers ------------------------------------------------
  app.use(
    helmet({
      // This is a JSON API; it serves no HTML, so a restrictive CSP here would
      // only affect error pages. The frontend sets its own.
      contentSecurityPolicy: false,
      // Allows the frontend on a different origin to read responses.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      // Referrer is not useful to upstreams and can leak paths.
      referrerPolicy: { policy: "no-referrer" },
      hsts: env.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  // ---- 4. CORS ------------------------------------------------------------
  const allowedOrigins = new Set(env.CORS_ORIGINS as string[]);

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin, curl, or a server-side call. Allowed —
        // credentials are still gated by the cookie.
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);

        logger.warn({ origin }, "blocked cross-origin request");
        // Reject by not allowing, rather than throwing: an Error here surfaces
        // as an opaque 500 instead of a clean CORS failure in the browser.
        return callback(null, false);
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization", "x-request-id", "x-internal-token"],
      exposedHeaders: ["x-request-id", "retry-after", "ratelimit-remaining", "ratelimit-reset"],
      maxAge: 86_400,
    }),
  );

  // ---- 5. body parsing ----------------------------------------------------
  // 1 MB is generous for this API: the largest payload is a merge-decision
  // justification. Diffs are fetched from GitHub, never uploaded.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());
  app.use(compression());

  // ---- 6. logging ---------------------------------------------------------
  app.use(httpLogger);

  // ---- 7. rate limiting ---------------------------------------------------
  // `optionalAuth` runs first so the limiter can key on user id where a session
  // exists, rather than lumping a whole office behind one NAT address together.
  app.use(env.apiPrefix, optionalAuth, generalLimiter);

  // ---- 8. routes ----------------------------------------------------------
  app.use(env.apiPrefix, apiRoutes);

  // Unversioned aliases for infrastructure probes, which conventionally expect
  // these exact paths and should not have to know the API version.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "bugdna-api", timestamp: new Date().toISOString() });
  });
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  app.get("/", (_req, res) => {
    res.json({
      data: {
        name: "BugDNA API",
        docs: `${env.apiPrefix}`,
        health: "/health",
      },
    });
  });

  // ---- 9. terminal handlers ----------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
