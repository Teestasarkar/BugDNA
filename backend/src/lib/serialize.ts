/**
 * JSON serialisation safety net.
 *
 * Prisma maps Postgres `BIGINT` to JavaScript `BigInt`, and `JSON.stringify`
 * throws `TypeError: Do not know how to serialize a BigInt`. Because GitHub ids
 * are 64-bit, several models carry BigInt columns.
 *
 * Every route maps rows through an explicit DTO (see each module's `*.mapper.ts`),
 * which is where the real conversion happens — but one missed field would turn
 * a working endpoint into a 500. Teaching `BigInt` how to serialise itself
 * removes that whole class of bug.
 *
 * BigInt is rendered as a **string**, not a number: GitHub ids exceed
 * `Number.MAX_SAFE_INTEGER`, and silently losing precision would be worse than
 * a type change the client can handle.
 */

interface BigIntWithToJSON {
  toJSON?: () => string;
}

export function installBigIntSerialization(): void {
  const proto = BigInt.prototype as unknown as BigIntWithToJSON;
  if (typeof proto.toJSON === "function") return;
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function toJSON(this: bigint) {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** Convert a BigInt-bearing value to a plain JSON-safe structure. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

/** Narrow a possibly-BigInt id to a string for DTOs. */
export function idToString(value: bigint | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "bigint" ? value.toString() : String(value);
}

/** Parse a client-supplied GitHub id back into BigInt, tolerating strings. */
export function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}

/** ISO-8601 or null — the only date shape the API emits. */
export function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Round to a fixed number of decimals, returning null for nullish input. */
export function round(value: number | null | undefined, decimals = 2): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
