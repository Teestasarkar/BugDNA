/**
 * Global search.
 *
 * Powers the command palette: one query across repositories, pull requests,
 * analyses and risk findings, returning a small ranked set per category rather
 * than one long undifferentiated list — because "payments" should surface the
 * payments repository *and* the risky PR in it, and the user knows which they
 * meant when they see them grouped.
 *
 * Every branch is scoped by the tenancy predicate. A search endpoint is the
 * easiest place in an application to accidentally leak another tenant's data,
 * so each query composes `repositoryAccessWhere` with an explicit AND.
 */
import { Prisma, prisma } from "../../lib/prisma";
import { repositoryAccessWhere } from "../repositories/repository.access";
import type { AuthContext } from "../../types/express";

export type SearchCategory =
  | "repositories"
  | "pullRequests"
  | "analyses"
  | "riskFactors"
  | "recommendations";

export interface SearchResultItem {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle: string | null;
  /** In-app link. */
  href: string;
  /** Category-specific extras the UI renders as badges. */
  meta: Record<string, unknown>;
}

export interface SearchResults {
  query: string;
  totalMatches: number;
  groups: Array<{ category: SearchCategory; label: string; items: SearchResultItem[] }>;
  /** True when results were capped, so the UI can offer "see all". */
  truncated: boolean;
}

const insensitive = (value: string): Prisma.StringFilter => ({
  contains: value,
  mode: "insensitive",
});

/**
 * Run the search.
 *
 * Uses `contains` rather than full-text search: it is index-assisted for the
 * prefix cases that matter here, needs no extra Postgres configuration, and
 * behaves predictably on the identifier-heavy strings (`payments-api`,
 * `feat/ledger-consolidation`) that make up most of this corpus. A `tsvector`
 * index is the natural upgrade if the corpus grows — noted in docs/Architecture.md.
 */
export async function search(
  auth: AuthContext,
  rawQuery: string,
  options: { limitPerCategory?: number; categories?: SearchCategory[] } = {},
): Promise<SearchResults> {
  const query = rawQuery.trim();
  const limit = Math.min(options.limitPerCategory ?? 5, 20);

  if (query.length < 2) {
    return { query, totalMatches: 0, groups: [], truncated: false };
  }

  const wanted = (category: SearchCategory): boolean =>
    !options.categories || options.categories.includes(category);

  const access = repositoryAccessWhere(auth);

  const [repositories, pullRequests, analyses, riskFactors, recommendations] =
    await Promise.all([
      wanted("repositories")
        ? prisma.repository.findMany({
            where: {
              AND: [
                access,
                { isActive: true },
                {
                  OR: [
                    { fullName: insensitive(query) },
                    { description: insensitive(query) },
                    { language: insensitive(query) },
                  ],
                },
              ],
            },
            take: limit,
            orderBy: { connectedAt: "desc" },
            select: {
              id: true,
              fullName: true,
              description: true,
              language: true,
              private: true,
              _count: { select: { pullRequests: true, analyses: true } },
            },
          })
        : Promise.resolve([]),

      wanted("pullRequests")
        ? prisma.pullRequest.findMany({
            where: {
              AND: [
                { repository: access },
                {
                  OR: [
                    { title: insensitive(query) },
                    { headRef: insensitive(query) },
                    { authorLogin: insensitive(query) },
                    // A bare number is almost always a PR number.
                    ...(/^\d+$/.test(query) ? [{ number: Number(query) }] : []),
                  ],
                },
              ],
            },
            take: limit,
            orderBy: { githubUpdatedAt: "desc" },
            select: {
              id: true,
              number: true,
              title: true,
              state: true,
              authorLogin: true,
              additions: true,
              deletions: true,
              changedFiles: true,
              repository: { select: { id: true, fullName: true } },
              analyses: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { id: true, riskScore: true, riskLevel: true, status: true },
              },
            },
          })
        : Promise.resolve([]),

      wanted("analyses")
        ? prisma.analysis.findMany({
            where: {
              AND: [
                { repository: access },
                { status: "COMPLETED" },
                {
                  OR: [
                    { summary: insensitive(query) },
                    { headSha: { startsWith: query } },
                    { pullRequest: { title: insensitive(query) } },
                  ],
                },
              ],
            },
            take: limit,
            orderBy: { completedAt: "desc" },
            select: {
              id: true,
              riskScore: true,
              riskLevel: true,
              summary: true,
              headSha: true,
              completedAt: true,
              repository: { select: { fullName: true } },
              pullRequest: { select: { number: true, title: true } },
            },
          })
        : Promise.resolve([]),

      wanted("riskFactors")
        ? prisma.riskFactor.findMany({
            where: {
              AND: [
                { analysis: { repository: access } },
                {
                  OR: [
                    { label: insensitive(query) },
                    { key: insensitive(query) },
                    { description: insensitive(query) },
                  ],
                },
              ],
            },
            take: limit,
            orderBy: [{ contribution: "desc" }],
            select: {
              id: true,
              key: true,
              label: true,
              displayValue: true,
              contribution: true,
              direction: true,
              category: true,
              analysis: {
                select: {
                  id: true,
                  riskLevel: true,
                  repository: { select: { fullName: true } },
                  pullRequest: { select: { number: true } },
                },
              },
            },
          })
        : Promise.resolve([]),

      wanted("recommendations")
        ? prisma.recommendation.findMany({
            where: {
              AND: [
                { analysis: { repository: access } },
                {
                  OR: [
                    { title: insensitive(query) },
                    { description: insensitive(query) },
                  ],
                },
              ],
            },
            take: limit,
            orderBy: [{ priority: "asc" }],
            select: {
              id: true,
              title: true,
              category: true,
              priority: true,
              analysis: {
                select: {
                  id: true,
                  riskLevel: true,
                  repository: { select: { fullName: true } },
                  pullRequest: { select: { number: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

  const groups: SearchResults["groups"] = [];

  if (repositories.length > 0) {
    groups.push({
      category: "repositories",
      label: "Repositories",
      items: repositories.map((r) => ({
        id: r.id,
        category: "repositories" as const,
        title: r.fullName,
        subtitle: r.description,
        href: `/repositories/${r.id}`,
        meta: {
          language: r.language,
          private: r.private,
          pullRequests: r._count.pullRequests,
          analyses: r._count.analyses,
        },
      })),
    });
  }

  if (pullRequests.length > 0) {
    groups.push({
      category: "pullRequests",
      label: "Pull requests",
      items: pullRequests.map((pr) => {
        const latest = pr.analyses[0];
        return {
          id: pr.id,
          category: "pullRequests" as const,
          title: `#${pr.number} ${pr.title}`,
          subtitle: `${pr.repository.fullName} · ${pr.authorLogin}`,
          href: `/pulls/${pr.id}`,
          meta: {
            state: pr.state,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            riskScore: latest?.riskScore ?? null,
            riskLevel: latest?.riskLevel ?? null,
            analysisId: latest?.id ?? null,
          },
        };
      }),
    });
  }

  if (analyses.length > 0) {
    groups.push({
      category: "analyses",
      label: "Analyses",
      items: analyses.map((a) => ({
        id: a.id,
        category: "analyses" as const,
        title: `#${a.pullRequest.number} ${a.pullRequest.title}`,
        subtitle: a.summary?.slice(0, 160) ?? a.repository.fullName,
        href: `/analyses/${a.id}`,
        meta: {
          riskScore: a.riskScore,
          riskLevel: a.riskLevel,
          repository: a.repository.fullName,
          sha: a.headSha.slice(0, 7),
          completedAt: a.completedAt?.toISOString() ?? null,
        },
      })),
    });
  }

  if (riskFactors.length > 0) {
    groups.push({
      category: "riskFactors",
      label: "Risk findings",
      items: riskFactors.map((f) => ({
        id: f.id,
        category: "riskFactors" as const,
        title: f.label,
        subtitle:
          `${f.analysis.repository.fullName} · #${f.analysis.pullRequest.number}` +
          (f.displayValue ? ` · ${f.displayValue}` : ""),
        href: `/analyses/${f.analysis.id}`,
        meta: {
          key: f.key,
          contribution: f.contribution,
          direction: f.direction,
          factorCategory: f.category,
          riskLevel: f.analysis.riskLevel,
        },
      })),
    });
  }

  if (recommendations.length > 0) {
    groups.push({
      category: "recommendations",
      label: "Recommendations",
      items: recommendations.map((r) => ({
        id: r.id,
        category: "recommendations" as const,
        title: r.title,
        subtitle: `${r.analysis.repository.fullName} · #${r.analysis.pullRequest.number}`,
        href: `/analyses/${r.analysis.id}`,
        meta: {
          priority: r.priority,
          recommendationCategory: r.category,
          riskLevel: r.analysis.riskLevel,
        },
      })),
    });
  }

  const totalMatches = groups.reduce((sum, group) => sum + group.items.length, 0);

  return {
    query,
    totalMatches,
    groups,
    truncated: groups.some((group) => group.items.length >= limit),
  };
}

/**
 * Recent items for an empty palette.
 *
 * A command palette that shows nothing before you type wastes the most common
 * interaction, which is returning to something you just looked at.
 */
export async function searchSuggestions(auth: AuthContext): Promise<SearchResultItem[]> {
  const access = repositoryAccessWhere(auth);

  const [recentAnalyses, recentRepositories] = await Promise.all([
    prisma.analysis.findMany({
      where: { repository: access, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      take: 5,
      select: {
        id: true,
        riskScore: true,
        riskLevel: true,
        repository: { select: { fullName: true } },
        pullRequest: { select: { number: true, title: true } },
      },
    }),
    prisma.repository.findMany({
      where: { AND: [access, { isActive: true }] },
      orderBy: { connectedAt: "desc" },
      take: 4,
      select: { id: true, fullName: true, language: true, private: true },
    }),
  ]);

  return [
    ...recentAnalyses.map((a) => ({
      id: a.id,
      category: "analyses" as const,
      title: `#${a.pullRequest.number} ${a.pullRequest.title}`,
      subtitle: a.repository.fullName,
      href: `/analyses/${a.id}`,
      meta: { riskScore: a.riskScore, riskLevel: a.riskLevel },
    })),
    ...recentRepositories.map((r) => ({
      id: r.id,
      category: "repositories" as const,
      title: r.fullName,
      subtitle: r.language,
      href: `/repositories/${r.id}`,
      meta: { private: r.private },
    })),
  ];
}
