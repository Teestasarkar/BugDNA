/**
 * Tenancy enforcement.
 *
 * The isolation rule lives here and nowhere else:
 *
 *     a user may read a repository if they connected it,
 *     or if it belongs to a team they are a member of.
 *
 * Every other resource — pull requests, changed files, analyses, risk factors,
 * recommendations, deployments, health snapshots — is a descendant of a
 * repository, so authorising the repository authorises the subtree. Controllers
 * call one of the `assert*` helpers and then query freely; they never hand-roll
 * an ownership check, because a single forgotten `where` clause is exactly how
 * cross-tenant leaks happen.
 *
 * Failure mode: **404, not 403.** Telling an attacker "this exists but is not
 * yours" leaks the existence of private repositories. The only exception is
 * where the caller demonstrably already knows about the resource (e.g. a team
 * they are a member of but lack the role for), where 403 is more useful.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { notFound } from "../../lib/errors";
import type { AuthContext } from "../../types/express";

/**
 * Prisma `where` fragment expressing the read predicate.
 *
 * Compose it into any Repository query:
 *
 *     prisma.repository.findMany({ where: { ...repositoryAccessWhere(auth), isActive: true } })
 */
export function repositoryAccessWhere(auth: AuthContext): Prisma.RepositoryWhereInput {
  const clauses: Prisma.RepositoryWhereInput[] = [{ ownerUserId: auth.userId }];

  if (auth.teamIds.length > 0) {
    clauses.push({ teamId: { in: auth.teamIds } });
  }

  return { OR: clauses };
}

/** The same predicate, nested for models that reference a repository. */
export function nestedRepositoryAccessWhere(
  auth: AuthContext,
): { repository: Prisma.RepositoryWhereInput } {
  return { repository: repositoryAccessWhere(auth) };
}

/** Non-throwing check, used by the realtime layer before joining a room. */
export async function canAccessRepository(
  auth: AuthContext,
  repositoryId: string,
): Promise<boolean> {
  const found = await prisma.repository.findFirst({
    where: { id: repositoryId, ...repositoryAccessWhere(auth) },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Assert access and return the repository.
 *
 * Pass `select` to fetch exactly what the caller needs in the same round trip,
 * so authorisation costs no extra query.
 */
export async function assertRepositoryAccess(
  auth: AuthContext,
  repositoryId: string,
): Promise<{ id: string; fullName: string; ownerUserId: string; teamId: string | null }> {
  const repository = await prisma.repository.findFirst({
    where: { id: repositoryId, ...repositoryAccessWhere(auth) },
    select: { id: true, fullName: true, ownerUserId: true, teamId: true },
  });

  if (!repository) throw notFound("Repository");
  return repository;
}

/** Assert access to a pull request via its repository. */
export async function assertPullRequestAccess(
  auth: AuthContext,
  pullRequestId: string,
): Promise<{
  id: string;
  number: number;
  repositoryId: string;
  headSha: string;
  title: string;
  state: string;
}> {
  const pr = await prisma.pullRequest.findFirst({
    where: { id: pullRequestId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      number: true,
      repositoryId: true,
      headSha: true,
      title: true,
      state: true,
    },
  });

  if (!pr) throw notFound("Pull request");
  return { ...pr, state: pr.state as string };
}

/** Non-throwing analysis check, used by the realtime layer before a room join. */
export async function canAccessAnalysis(
  auth: AuthContext,
  analysisId: string,
): Promise<boolean> {
  const found = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: { id: true },
  });
  return found !== null;
}

/** Assert access to an analysis via its repository. */
export async function assertAnalysisAccess(
  auth: AuthContext,
  analysisId: string,
): Promise<{ id: string; repositoryId: string; pullRequestId: string; status: string }> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: repositoryAccessWhere(auth) },
    select: { id: true, repositoryId: true, pullRequestId: true, status: true },
  });

  if (!analysis) throw notFound("Analysis");
  return { ...analysis, status: analysis.status as string };
}

/** Assert membership of a team (any role). */
export async function assertTeamAccess(
  auth: AuthContext,
  teamId: string,
): Promise<{ teamId: string; role: string }> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: auth.userId } },
    select: { teamId: true, role: true },
  });

  if (!membership) throw notFound("Team");
  return { teamId: membership.teamId, role: membership.role as string };
}

/**
 * Every repository id the caller can read.
 *
 * Used by the cross-repository views — global search, the dashboard rollup and
 * the deployment timeline — which aggregate over "everything I can see" rather
 * than one repository at a time.
 */
export async function accessibleRepositoryIds(auth: AuthContext): Promise<string[]> {
  const rows = await prisma.repository.findMany({
    where: repositoryAccessWhere(auth),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
