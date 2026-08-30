/**
 * Cross-process event bus.
 *
 * The analysis worker runs in its own process (and, in production, its own
 * container), but the browser's Socket.io connection is held by an API process.
 * Without a bus, progress updates emitted by the worker would reach nobody.
 *
 * So: publishers push a `RealtimeEvent` onto a Redis pub/sub channel, and every
 * API process subscribes and fans the event out to its local Socket.io rooms.
 * Two consequences worth noting:
 *
 *  - the API scales horizontally for free — each instance delivers to the
 *    clients it happens to hold;
 *  - realtime is strictly best-effort. Every event mirrors state already
 *    committed to Postgres, so a dropped message costs a client a live update,
 *    never correctness. The frontend also refetches on reconnect.
 */
import { redis, createSubscriber } from "../lib/redis";
import { scoped } from "../lib/logger";
import type { RealtimeEvent } from "./events";

const log = scoped("bus");

const CHANNEL = "bugdna:realtime";

/**
 * Publish an event. Never throws: a realtime failure must not roll back the
 * database work that produced it.
 */
export async function publishEvent(event: RealtimeEvent): Promise<void> {
  if (event.rooms.length === 0) return;

  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
    log.debug({ name: event.name, rooms: event.rooms }, "event published");
  } catch (e) {
    log.warn({ err: e, name: event.name }, "failed to publish realtime event");
  }
}

/**
 * Subscribe to the bus. Returns a disposer.
 *
 * Uses a dedicated connection because a Redis client in subscriber mode cannot
 * issue ordinary commands.
 */
export function subscribeEvents(handler: (event: RealtimeEvent) => void): () => Promise<void> {
  const subscriber = createSubscriber("realtime-sub");

  subscriber.subscribe(CHANNEL).then(
    () => log.info({ channel: CHANNEL }, "subscribed to realtime bus"),
    (e) => log.error({ err: e }, "failed to subscribe to realtime bus"),
  );

  subscriber.on("message", (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      handler(JSON.parse(message) as RealtimeEvent);
    } catch (e) {
      log.warn({ err: e }, "discarded malformed realtime event");
    }
  });

  return async () => {
    try {
      await subscriber.unsubscribe(CHANNEL);
      await subscriber.quit();
    } catch (e) {
      log.warn({ err: e }, "error closing realtime subscriber");
    }
  };
}
