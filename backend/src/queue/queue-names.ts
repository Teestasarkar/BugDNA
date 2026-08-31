/**
 * Queue identifier rules.
 *
 * Deliberately its own module with no imports: `queues.ts` opens a Redis
 * connection at import time, so the validation used by `config/env.ts` has to
 * live somewhere a test can reach without standing up Redis.
 */

/**
 * BullMQ composes its Redis keys as `{prefix}:{queueName}:{...}`, so a colon in
 * either part is ambiguous. The library rejects it from the Queue and Worker
 * constructors — `Error: Queue name cannot contain :` — which lands as a crash
 * during boot rather than as a configuration error.
 */
export const QUEUE_KEY_SEPARATOR = ":";

/** True if `value` is usable as a BullMQ queue name or key prefix. */
export function isValidQueueIdentifier(value: string): boolean {
  return value.length > 0 && !value.includes(QUEUE_KEY_SEPARATOR);
}
