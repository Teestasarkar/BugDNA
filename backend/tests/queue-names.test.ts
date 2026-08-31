import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  QUEUE_KEY_SEPARATOR,
  isValidQueueIdentifier,
} from "../src/queue/queue-names";

/**
 * These exist because a colon in the queue name shipped to a real deploy and
 * crashed the API at boot with `Queue name cannot contain :`. Nothing in the
 * type system or the unit tests could see it: the value was a valid string, and
 * the throw came from inside BullMQ's constructor.
 */
describe("queue identifiers", () => {
  it("rejects the separator BullMQ builds its keys from", () => {
    expect(QUEUE_KEY_SEPARATOR).toBe(":");
    expect(isValidQueueIdentifier("bugdna:analysis")).toBe(false);
    expect(isValidQueueIdentifier(":")).toBe(false);
    expect(isValidQueueIdentifier("a:b:c")).toBe(false);
  });

  it("rejects empty, which would collapse the key namespace", () => {
    expect(isValidQueueIdentifier("")).toBe(false);
  });

  it("accepts the names actually in use", () => {
    for (const ok of ["analysis", "bugdna", "bugdna-analysis", "bugdna_analysis"]) {
      expect(isValidQueueIdentifier(ok)).toBe(true);
    }
  });

  /**
   * The predicate being right is not the same as the shipped configuration
   * being right — the bug was in a default value, not in a check. This reads
   * the committed example file, which is what a deployment is copied from.
   */
  it("the committed .env.example holds valid identifiers", () => {
    const file = path.resolve(__dirname, "../../.env.example");
    const text = fs.readFileSync(file, "utf8");

    const read = (key: string): string => {
      const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
      expect(match, `${key} is missing from .env.example`).not.toBeNull();
      return (match?.[1] ?? "").trim();
    };

    for (const key of ["ANALYSIS_QUEUE_NAME", "QUEUE_PREFIX"]) {
      const value = read(key);
      expect(isValidQueueIdentifier(value), `${key}=${value}`).toBe(true);
    }
  });
});
