/**
 * Redis cache helper.
 *
 * Two rules the rest of the codebase relies on:
 *
 *  1. **The cache never breaks the product.** Every operation degrades to a
 *     miss on error. A dead Redis makes BugDNA slower, not broken.
 *  2. **The cache is never authoritative.** Values here are derived from
 *     Postgres or GitHub and are always safe to discard.
 */
import { redis } from "./redis";
import { scoped } from "./logger";

const log = scoped("cache");

/** Read a JSON value. Returns undefined on miss *or* any failure. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await redis.get(key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch (e) {
    log.warn({ err: e, key }, "cache read failed, treating as miss");
    return undefined;
  }
}

/** Write a JSON value with a TTL. A TTL of 0 disables caching for that key. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (e) {
    log.warn({ err: e, key }, "cache write failed");
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (e) {
    log.warn({ err: e, keys }, "cache delete failed");
  }
}

/**
 * Delete every key matching a glob.
 *
 * Uses SCAN rather than KEYS so it never blocks the Redis event loop — this
 * runs on user-facing invalidation paths (e.g. "a new analysis landed, drop
 * this repo's analytics").
 */
export async function cacheDelPattern(pattern: string): Promise<number> {
  let deleted = 0;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");
  } catch (e) {
    log.warn({ err: e, pattern }, "pattern delete failed");
  }
  return deleted;
}

/**
 * Read-through cache.
 *
 * On a miss the loader runs and its result is cached. Loader failures are *not*
 * cached — a transient GitHub error must not be remembered for the full TTL.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const existing = await cacheGet<T>(key);
  if (existing !== undefined) return { value: existing, hit: true };

  const value = await loader();
  await cacheSet(key, value, ttlSeconds);
  return { value, hit: false };
}

/**
 * Transient key/value state for in-flight work (analysis progress).
 *
 * Distinct from `cacheSet` only in intent: these keys describe something
 * happening *now* and are read by the realtime layer, whereas cache keys are
 * memoised reads. Keeping them apart makes the Redis usage legible.
 */
export async function stateSet(
  key: string,
  value: Record<string, unknown>,
  ttlSeconds: number,
): Promise<void> {
  await cacheSet(key, value, ttlSeconds);
}

export async function stateGet<T>(key: string): Promise<T | undefined> {
  return cacheGet<T>(key);
}

/** Increment a counter with a TTL applied on first write. */
export async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  try {
    const value = await redis.incr(key);
    if (value === 1) await redis.expire(key, ttlSeconds);
    return value;
  } catch (e) {
    log.warn({ err: e, key }, "counter increment failed");
    return 0;
  }
}
