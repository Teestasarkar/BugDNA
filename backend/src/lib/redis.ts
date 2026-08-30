/**
 * Redis connections.
 *
 * Three separate clients, on purpose:
 *
 *  - `redis`        general commands (cache, transient state, locks)
 *  - `queueRedis`   BullMQ requires `maxRetriesPerRequest: null` and its own
 *                   connection; sharing one with the app causes BullMQ to
 *                   error under reconnects
 *  - `subRedis`     Socket.io adapter / pub-sub, since a subscribed client
 *                   cannot issue normal commands
 *
 * Redis is treated as a cache and coordination layer only. Every key here is
 * reconstructible from Postgres, so a flushed Redis costs latency, not data.
 */
import Redis, { type RedisOptions } from "ioredis";
import { env } from "../config/env";
import { scoped } from "./logger";

const log = scoped("redis");

const baseOptions: RedisOptions = {
  lazyConnect: false,
  enableReadyCheck: true,
  // Cap reconnect backoff so a long outage doesn't wedge the client.
  retryStrategy: (times) => Math.min(times * 200, 5_000),
  reconnectOnError: (err) => {
    // READONLY happens on failover to a replica; reconnecting resolves it.
    if (err.message.includes("READONLY")) return 2;
    return false;
  },
};

function create(name: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(env.REDIS_URL, { ...baseOptions, ...overrides });

  client.on("connect", () => log.debug({ client: name }, "connecting"));
  client.on("ready", () => log.info({ client: name }, "ready"));
  client.on("error", (err) => log.error({ client: name, err: err.message }, "error"));
  client.on("close", () => log.warn({ client: name }, "connection closed"));
  client.on("reconnecting", (delay: number) =>
    log.warn({ client: name, delay }, "reconnecting"),
  );

  return client;
}

/** General-purpose client: cache, locks, transient analysis state. */
export const redis = create("app");

/**
 * BullMQ client. `maxRetriesPerRequest: null` and `enableReadyCheck: false`
 * are required by BullMQ — with the defaults, blocking commands used by the
 * worker throw during reconnects.
 */
export const queueRedis = create("queue", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/** Duplicate for pub-sub; a subscriber cannot run ordinary commands. */
export function createSubscriber(name = "sub"): Redis {
  return create(name, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export async function checkRedis(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    if (pong !== "PONG") return { ok: false, error: `unexpected ping reply: ${pong}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), queueRedis.quit()]);
  log.info("disconnected");
}

/**
 * Best-effort distributed lock via SET NX PX.
 *
 * Used to stop two requests queueing duplicate analyses for the same PR head
 * SHA. Deliberately not a consensus lock — the worst case is a duplicate
 * analysis, which is harmless and idempotent at the persistence layer.
 */
export async function acquireLock(
  key: string,
  ttlSeconds: number,
  token: string,
): Promise<boolean> {
  try {
    const res = await redis.set(key, token, "EX", ttlSeconds, "NX");
    return res === "OK";
  } catch (e) {
    log.warn({ err: e, key }, "lock acquisition failed; proceeding without lock");
    // Fail open: an unavailable cache must not block the product.
    return true;
  }
}

/** Release a lock only if we still own it (compare-and-delete). */
export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    await redis.eval(script, 1, key, token);
  } catch (e) {
    log.warn({ err: e, key }, "lock release failed");
  }
}
