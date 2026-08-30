/**
 * Socket.io server.
 *
 * Responsibilities, in order of importance:
 *
 *  1. **Authenticate the connection.** The handshake carries the same session
 *     cookie as an HTTP request, verified through the same code path. An
 *     unauthenticated socket is rejected at the handshake, not later.
 *  2. **Authorise room joins.** A client asking to follow `analysis:<id>` only
 *     gets it if the tenancy predicate says it may read that analysis. Without
 *     this check the socket layer would be a hole straight around the REST
 *     authorisation.
 *  3. **Fan out bus events** to the rooms this process happens to hold.
 */
import type { Server as HttpServer } from "node:http";
import { Server as IOServer, type Socket } from "socket.io";
import { parse as parseCookie } from "cookie";
import { env } from "../config/env";
import { scoped } from "../lib/logger";
import { EVENT, ROOM, type RealtimeEvent } from "./events";
import { subscribeEvents } from "./bus";
import { resolveAuthContext, verifySessionToken } from "../modules/auth/session.service";
import {
  canAccessAnalysis,
  canAccessRepository,
} from "../modules/repositories/repository.access";
import type { AuthContext } from "../types/express";

const log = scoped("socket");

/** Auth context attached to each connected socket. */
interface SocketData {
  auth: AuthContext;
}

let io: IOServer | undefined;
let disposeBus: (() => Promise<void>) | undefined;

export function getIo(): IOServer | undefined {
  return io;
}

export function initRealtime(httpServer: HttpServer): IOServer {
  io = new IOServer(httpServer, {
    path: "/socket.io",
    cors: {
      origin: env.CORS_ORIGINS as string[],
      credentials: true,
    },
    // Allow polling as a fallback: some corporate proxies break websockets, and
    // silently losing realtime is worse than a slower transport.
    transports: ["websocket", "polling"],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Realtime payloads are small; a low cap limits abuse.
    maxHttpBufferSize: 64 * 1024,
  });

  // ---- handshake authentication -------------------------------------------
  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) return next(new Error("UNAUTHENTICATED"));

      const claims = verifySessionToken(token);
      if (!claims) return next(new Error("SESSION_EXPIRED"));

      const auth = await resolveAuthContext(claims.sid);
      if (!auth) return next(new Error("SESSION_EXPIRED"));

      (socket.data as SocketData).auth = auth;
      next();
    } catch (e) {
      log.warn({ err: e }, "socket handshake failed");
      next(new Error("UNAUTHENTICATED"));
    }
  });

  io.on("connection", (socket) => {
    const { auth } = socket.data as SocketData;

    // Personal stream: notifications and anything addressed to the user.
    void socket.join(ROOM.user(auth.userId));

    log.debug({ socketId: socket.id, userId: auth.userId }, "client connected");

    socket.on("subscribe:analysis", async (analysisId: unknown) => {
      if (typeof analysisId !== "string" || analysisId.length > 40) return;

      // Authorised through the repository that owns the analysis, using the
      // same predicate the REST layer uses.
      if (!(await canAccessAnalysis(auth, analysisId))) {
        socket.emit("subscribe:denied", { room: ROOM.analysis(analysisId) });
        return;
      }

      void socket.join(ROOM.analysis(analysisId));
      socket.emit("subscribe:ok", { room: ROOM.analysis(analysisId) });
    });

    socket.on("unsubscribe:analysis", (analysisId: unknown) => {
      if (typeof analysisId !== "string") return;
      void socket.leave(ROOM.analysis(analysisId));
    });

    socket.on("subscribe:repository", async (repositoryId: unknown) => {
      if (typeof repositoryId !== "string" || repositoryId.length > 40) return;

      if (!(await canAccessRepository(auth, repositoryId))) {
        socket.emit("subscribe:denied", { room: ROOM.repository(repositoryId) });
        return;
      }

      void socket.join(ROOM.repository(repositoryId));
      socket.emit("subscribe:ok", { room: ROOM.repository(repositoryId) });
    });

    socket.on("unsubscribe:repository", (repositoryId: unknown) => {
      if (typeof repositoryId !== "string") return;
      void socket.leave(ROOM.repository(repositoryId));
    });

    socket.on("disconnect", (reason) => {
      log.debug({ socketId: socket.id, reason }, "client disconnected");
    });
  });

  // ---- bus -> sockets ------------------------------------------------------
  disposeBus = subscribeEvents((event: RealtimeEvent) => {
    if (!io) return;
    for (const room of event.rooms) {
      io.to(room).emit(event.name, event.payload);
    }
  });

  log.info({ path: "/socket.io" }, "realtime server initialised");
  return io;
}

/**
 * Extract the session token from a handshake.
 *
 * Browsers send it as a cookie (`withCredentials: true` on the client). The
 * `auth.token` fallback exists for non-browser clients that cannot set cookies.
 */
function extractToken(socket: Socket): string | undefined {
  const rawCookie = socket.handshake.headers.cookie;
  if (rawCookie) {
    const parsed = parseCookie(rawCookie);
    const fromCookie = parsed[env.COOKIE_NAME];
    if (fromCookie) return fromCookie;
  }

  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;

  return undefined;
}

export async function shutdownRealtime(): Promise<void> {
  await disposeBus?.();
  if (io) {
    await new Promise<void>((resolve) => io?.close(() => resolve()));
    io = undefined;
    log.info("realtime server closed");
  }
}

export { EVENT, ROOM };
