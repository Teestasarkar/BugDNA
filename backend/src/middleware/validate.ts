/**
 * Request validation.
 *
 * Nothing reaches a service layer unvalidated. `validate` parses body / query /
 * params with Zod and **replaces** them with the parsed result, so downstream
 * code works with coerced, typed values (a query string `?page=2` arrives as the
 * number 2) and unknown keys are stripped rather than silently forwarded.
 *
 * Routes rely on that replacement completely: they cast `req.query` to the
 * schema's output type rather than re-reading raw strings. If the replacement
 * does not take effect the cast is a lie and every default silently becomes
 * undefined, so the mechanism is covered by tests in tests/validate.test.ts.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { validationFailed } from "../lib/errors";
import { PAGINATION } from "../config/constants";

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

interface FieldIssue {
  path: string;
  message: string;
  code: string;
}

function collect(source: "body" | "query" | "params", error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    path: [source, ...i.path.map(String)].filter(Boolean).join("."),
    message: i.message,
    code: i.code,
  }));
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return function validateRequest(req: Request, _res: Response, next: NextFunction): void {
    const issues: FieldIssue[] = [];

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (result.success) Object.assign(req.params, result.data);
      else issues.push(...collect("params", result.error));
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (result.success) {
        // Express 5 defines `query` as an accessor that re-parses the URL on
        // *every* read, so it returns a fresh object each time. That makes both
        // obvious approaches wrong: plain assignment does not stick (there is no
        // setter), and mutating in place mutates a throwaway object. The parsed
        // values, including every default and coercion, were being discarded —
        // which turned `?page` defaults into `undefined` and, downstream,
        // `(page - 1) * perPage` into NaN.
        //
        // Replacing the accessor with an own value property is the supported
        // fix: reads are stable, and downstream code gets what Zod produced.
        Object.defineProperty(req, "query", {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        issues.push(...collect("query", result.error));
      }
    }

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (result.success) req.body = result.data;
      else issues.push(...collect("body", result.error));
    }

    if (issues.length > 0) {
      next(validationFailed(issues));
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Reusable schema fragments
// ---------------------------------------------------------------------------

/** cuid()-shaped identifier, as produced by Prisma's `@default(cuid())`. */
export const cuidSchema = z
  .string()
  .min(20, "must be a valid id")
  .max(40)
  .regex(/^[a-z0-9]+$/i, "must be a valid id");

export const idParam = (name = "id") =>
  z.object({ [name]: cuidSchema } as Record<string, typeof cuidSchema>);

/** Standard page/perPage pair, clamped so a client cannot request 10k rows. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGINATION.defaultPage),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION.maxPerPage)
    .default(PAGINATION.defaultPerPage),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Convert page/perPage into Prisma's skip/take.
 *
 * The finiteness guards are deliberate. Zod makes both values numbers, so on
 * the validated path they are redundant — but this function is the only
 * producer of `skip`, and a NaN escaping it is close to undiagnosable: Prisma
 * serialises NaN as absent and reports "Argument `skip` is missing" from a call
 * site that visibly passes `skip`. `?? 0` downstream does not help, because
 * `??` only catches null and undefined. Clamping here makes the bad value
 * unrepresentable at its source instead.
 */
export function toSkipTake(p: Pagination): { skip: number; take: number } {
  const page = Number.isFinite(p.page) ? p.page : PAGINATION.defaultPage;
  const perPage = Number.isFinite(p.perPage) ? p.perPage : PAGINATION.defaultPerPage;
  return { skip: (page - 1) * perPage, take: perPage };
}

/** Trimmed, length-capped free text — used for search queries and reasons. */
export const shortText = (max = 500) => z.string().trim().min(1).max(max);

/** A "last N days" window, used across analytics endpoints. */
export const daysSchema = z.coerce.number().int().min(1).max(365).default(30);

/** Sort direction shared by list endpoints. */
export const sortOrderSchema = z.enum(["asc", "desc"]).default("desc");
