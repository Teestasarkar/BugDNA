/**
 * Request validation.
 *
 * Nothing reaches a service layer unvalidated. `validate` parses body / query /
 * params with Zod and **replaces** them with the parsed result, so downstream
 * code works with coerced, typed values (a query string `?page=2` arrives as the
 * number 2) and unknown keys are stripped rather than silently forwarded.
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
        // Express 5 makes req.query a getter, so assigning to it throws.
        // Mutating in place keeps the parsed/coerced values without fighting it.
        for (const key of Object.keys(req.query)) {
          delete (req.query as Record<string, unknown>)[key];
        }
        Object.assign(req.query, result.data);
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

/** Convert page/perPage into Prisma's skip/take. */
export function toSkipTake(p: Pagination): { skip: number; take: number } {
  return { skip: (p.page - 1) * p.perPage, take: p.perPage };
}

/** Trimmed, length-capped free text — used for search queries and reasons. */
export const shortText = (max = 500) => z.string().trim().min(1).max(max);

/** A "last N days" window, used across analytics endpoints. */
export const daysSchema = z.coerce.number().int().min(1).max(365).default(30);

/** Sort direction shared by list endpoints. */
export const sortOrderSchema = z.enum(["asc", "desc"]).default("desc");
