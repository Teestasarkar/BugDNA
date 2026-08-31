import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { z } from "zod";
import { validate, paginationSchema, toSkipTake } from "../src/middleware/validate";

/**
 * These cover the mechanism the whole API depends on and no test previously
 * touched.
 *
 * Routes do not read raw query strings; they cast `req.query` to the Zod
 * schema's output type and use it directly. That cast is only honest if
 * `validate` genuinely replaced `req.query`. It was not: Express 5 defines
 * `query` as an accessor that re-parses the URL on every read and hands back a
 * fresh object, so the middleware's in-place mutation was applied to a
 * throwaway. Every default and coercion was discarded.
 *
 * The visible symptom was three layers away and looked nothing like the cause:
 * `page` arrived undefined, `toSkipTake` computed `(undefined - 1) * 20` = NaN,
 * `NaN ?? 0` is NaN because `??` only catches null and undefined, and Prisma
 * serialises NaN as absent — so the API returned
 * "Argument `skip` is missing" from a call site that plainly passes `skip`.
 */

async function get(app: express.Express, url: string): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe("validate: query replacement", () => {
  /**
   * Documents the platform behaviour the fix exists for. If a future Express
   * makes `query` a stable own property, this test failing is the signal that
   * the workaround can be simplified — not a regression.
   */
  it("Express hands back a fresh query object on every read", async () => {
    const app = express();
    app.get("/probe", (req, res) => {
      const first = req.query as Record<string, unknown>;
      first.injected = "yes";
      res.json({ stable: first === req.query, mutationSurvived: "injected" in req.query });
    });

    const { body } = await get(app, "/probe?a=1");
    expect(body).toEqual({ stable: false, mutationSurvived: false });
  });

  it("applies schema defaults so a route's cast is truthful", async () => {
    const app = express();
    app.get(
      "/list",
      validate({ query: paginationSchema }),
      (req, res) => {
        const q = req.query as unknown as { page: number; perPage: number };
        res.json({ page: q.page, perPage: q.perPage, ...toSkipTake(q) });
      },
    );

    // No query string at all: every value must come from the schema.
    const { body } = await get(app, "/list");
    expect(body).toEqual({ page: 1, perPage: 20, skip: 0, take: 20 });
  });

  it("coerces strings to numbers, so skip is never NaN", async () => {
    const app = express();
    app.get("/list", validate({ query: paginationSchema }), (req, res) => {
      const q = req.query as unknown as { page: number; perPage: number };
      const { skip, take } = toSkipTake(q);
      res.json({ pageType: typeof q.page, skip, take, skipIsNaN: Number.isNaN(skip) });
    });

    const { body } = await get(app, "/list?page=3&perPage=10");
    expect(body).toEqual({ pageType: "number", skip: 20, take: 10, skipIsNaN: false });
  });

  it("strips unknown keys rather than forwarding them", async () => {
    const app = express();
    app.get(
      "/list",
      validate({ query: z.object({ sort: z.enum(["recent", "name"]).default("recent") }) }),
      (req, res) => res.json({ keys: Object.keys(req.query) }),
    );

    const { body } = await get(app, "/list?sort=name&somethingElse=drop-me");
    expect(body).toEqual({ keys: ["sort"] });
  });

  it("the replacement survives a later middleware in the same chain", async () => {
    // Ordering matters: validate runs before the handler, and anything reading
    // req.query in between must see the parsed values too.
    const app = express();
    const seen: Array<string | number | undefined> = [];
    app.get(
      "/list",
      validate({ query: paginationSchema }),
      (req, _res, next) => {
        seen.push((req.query as unknown as { page: number }).page);
        next();
      },
      (req, res) => {
        seen.push((req.query as unknown as { page: number }).page);
        res.json({ seen });
      },
    );

    const { body } = await get(app, "/list?page=4");
    expect(body).toEqual({ seen: [4, 4] });
  });
});

describe("toSkipTake", () => {
  it("computes skip from page and perPage", () => {
    expect(toSkipTake({ page: 1, perPage: 20 })).toEqual({ skip: 0, take: 20 });
    expect(toSkipTake({ page: 3, perPage: 10 })).toEqual({ skip: 20, take: 10 });
  });

  /**
   * Zod makes this unreachable on the validated path. It is asserted anyway
   * because a NaN escaping here is what made the original bug so expensive:
   * Prisma serialises NaN as absent and reports the argument as *missing* from
   * a call site that plainly passes it.
   */
  it("never emits NaN, even if handed junk", () => {
    for (const bad of [NaN, undefined, Infinity] as unknown as number[]) {
      const { skip, take } = toSkipTake({ page: bad, perPage: bad });
      expect(Number.isFinite(skip), `skip from page=${String(bad)}`).toBe(true);
      expect(Number.isFinite(take), `take from perPage=${String(bad)}`).toBe(true);
    }
  });
});
