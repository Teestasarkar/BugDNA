/**
 * Search routes.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/error";
import { requireAuth } from "../../middleware/auth";
import { searchLimiter } from "../../middleware/rateLimit";
import { validate } from "../../middleware/validate";
import { search, searchSuggestions, type SearchCategory } from "./search.service";

const router = Router();

router.use(requireAuth);

const categorySchema = z.enum([
  "repositories",
  "pullRequests",
  "analyses",
  "riskFactors",
  "recommendations",
]);

// ---------------------------------------------------------------------------
// GET /search?q=
// ---------------------------------------------------------------------------
router.get(
  "/",
  searchLimiter,
  validate({
    query: z.object({
      q: z.string().trim().max(200).default(""),
      limit: z.coerce.number().int().min(1).max(20).default(5),
      category: z
        .union([categorySchema, z.array(categorySchema)])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      q: string;
      limit: number;
      category?: SearchCategory[];
    };

    // An empty query returns recents rather than nothing, so the palette is
    // useful the moment it opens.
    if (query.q.trim().length < 2) {
      const suggestions = await searchSuggestions(req.user());
      res.json({
        data: {
          query: query.q,
          totalMatches: suggestions.length,
          groups:
            suggestions.length > 0
              ? [{ category: "analyses" as const, label: "Recent", items: suggestions }]
              : [],
          truncated: false,
        },
        meta: { suggestions: true },
      });
      return;
    }

    const results = await search(req.user(), query.q, {
      limitPerCategory: query.limit,
      ...(query.category ? { categories: query.category } : {}),
    });

    res.json({ data: results, meta: { suggestions: false } });
  }),
);

export default router;
