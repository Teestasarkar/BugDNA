/**
 * Recommendation rules.
 *
 * The design constraint that shapes this whole file: **a recommendation must be
 * caused by something detected in this pull request.** "Consider adding tests"
 * appearing on every PR is noise that trains people to ignore the tool. So every
 * rule here declares:
 *
 *  - a `when` predicate over the extracted features and the model's own factors,
 *    so it fires only when the signal is genuinely present;
 *  - the `triggeredBy` feature keys, persisted as an audit trail from
 *    "why is this risky" to "what should I do";
 *  - `targets`, drawn from the extraction evidence, so the advice names the
 *    actual files rather than gesturing at the codebase.
 *
 * Rules are ordered by the priority they resolve to, and the pipeline keeps the
 * top N. A PR that trips nothing produces no recommendations, which is the
 * correct output for a clean change — not a filler suggestion.
 */
import type { FeatureVector } from "../features/registry";
import type { FeatureEvidence } from "../features/extract";
import type { RiskFactorDraft } from "../explain/explain";

export type RecommendationCategory =
  | "TESTING"
  | "CODE_REVIEW"
  | "DEPENDENCY"
  | "DATABASE"
  | "API_CONTRACT"
  | "CONFIGURATION"
  | "SECURITY"
  | "OBSERVABILITY"
  | "ROLLOUT"
  | "SCOPE"
  | "DOCUMENTATION";

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Effort = "LOW" | "MEDIUM" | "HIGH";

export interface RuleContext {
  features: FeatureVector;
  evidence: Record<string, FeatureEvidence>;
  factors: RiskFactorDraft[];
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  riskScore: number;
  modules: Array<{ module: string; churn: number; files: number }>;
  pullRequest: { number: number; authorLogin: string; title: string };
}

export interface RecommendationDraft {
  ruleId: string;
  title: string;
  description: string;
  rationale: string;
  category: RecommendationCategory;
  priority: Priority;
  effort: Effort;
  triggeredByFactorKeys: string[];
  targets: { files?: string[]; modules?: string[] } | null;
}

interface Rule {
  id: string;
  category: RecommendationCategory;
  effort: Effort;
  /** Feature keys that must be present for this rule to be considered relevant. */
  triggeredBy: string[];
  when(ctx: RuleContext): boolean;
  build(ctx: RuleContext): { title: string; description: string; rationale: string };
  /** Base priority; escalated by `escalate` when overall risk is high. */
  priority(ctx: RuleContext): Priority;
  targets?(ctx: RuleContext): { files?: string[]; modules?: string[] } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const f = (ctx: RuleContext, key: string): number => ctx.features[key] ?? 0;
const on = (ctx: RuleContext, key: string): boolean => f(ctx, key) >= 0.5;
const files = (ctx: RuleContext, key: string): string[] => ctx.evidence[key]?.files ?? [];

/** Raise priority one step when the overall assessment is severe. */
function escalate(base: Priority, riskLevel: RuleContext["riskLevel"]): Priority {
  if (riskLevel !== "CRITICAL" && riskLevel !== "HIGH") return base;
  const order: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const idx = order.indexOf(base);
  return order[Math.min(idx + 1, order.length - 1)] as Priority;
}

const list = (items: string[], max = 4): string => {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES: readonly Rule[] = [
  // --- testing -------------------------------------------------------------
  {
    id: "add-tests-for-untested-change",
    category: "TESTING",
    effort: "MEDIUM",
    triggeredBy: ["touches_tests", "source_files_changed", "total_churn"],
    when: (ctx) =>
      !on(ctx, "touches_tests") &&
      f(ctx, "source_files_changed") > 0 &&
      f(ctx, "total_churn") >= 40 &&
      !on(ctx, "docs_only_change"),
    priority: (ctx) => escalate(f(ctx, "total_churn") > 300 ? "HIGH" : "MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const changed = Math.round(f(ctx, "source_files_changed"));
      const modules = ctx.modules.filter((m) => m.module !== "(root)").slice(0, 3);
      return {
        title: "Add tests covering the changed behaviour",
        description:
          `This pull request modifies ${changed} source ${changed === 1 ? "file" : "files"} ` +
          `but contains no test changes. ` +
          (modules.length
            ? `Start with ${list(modules.map((m) => m.module))} — ${modules[0]?.module} carries the most churn.`
            : `Add coverage for the paths this change introduces.`),
        rationale:
          "Changing behaviour without moving any test means nothing verifies the new path " +
          "before it reaches production. This is the single most actionable risk factor on " +
          "this pull request.",
      };
    },
    targets: (ctx) => ({
      modules: ctx.modules.filter((m) => m.module !== "(root)").map((m) => m.module).slice(0, 5),
    }),
  },
  {
    id: "strengthen-thin-test-coverage",
    category: "TESTING",
    effort: "MEDIUM",
    triggeredBy: ["test_to_source_ratio", "total_churn"],
    when: (ctx) =>
      on(ctx, "touches_tests") &&
      f(ctx, "test_to_source_ratio") < 0.15 &&
      f(ctx, "total_churn") >= 200,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => ({
      title: "Extend the test changes to match the size of the change",
      description:
        `Test churn is only ${Math.round(f(ctx, "test_to_source_ratio") * 100)}% of source churn on a ` +
        `${Math.round(f(ctx, "total_churn"))}-line change. The tests that were touched are unlikely to ` +
        `cover the new branches.`,
      rationale:
        "A token test change on a large diff often means one existing test was adjusted to " +
        "keep the suite green, rather than new cases being added.",
    }),
    targets: (ctx) => ({ files: files(ctx, "test_files_changed") }),
  },

  // --- database ------------------------------------------------------------
  {
    id: "review-destructive-schema-change",
    category: "DATABASE",
    effort: "HIGH",
    triggeredBy: ["has_destructive_sql", "migration_files_changed"],
    when: (ctx) => on(ctx, "has_destructive_sql"),
    priority: () => "CRITICAL",
    build: (ctx) => {
      const targets = files(ctx, "has_destructive_sql");
      return {
        title: "Confirm the destructive migration is reversible and safe to run",
        description:
          `${list(targets)} ${targets.length === 1 ? "contains" : "contain"} a DROP, TRUNCATE, ` +
          `unqualified DELETE, or a new NOT NULL column without a default. Before merging: verify ` +
          `the data is backed up or backfilled, confirm no running code reads the dropped columns, ` +
          `and check the migration completes within the deploy window on production-sized data.`,
        rationale:
          "Schema deletions cannot be undone by reverting the pull request — the data is already " +
          "gone. Adding NOT NULL without a default fails outright on a populated table, taking the " +
          "deploy down with it.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "has_destructive_sql") }),
  },
  {
    id: "plan-migration-rollback",
    category: "DATABASE",
    effort: "MEDIUM",
    triggeredBy: ["migration_files_changed"],
    when: (ctx) => f(ctx, "migration_files_changed") > 0 && !on(ctx, "has_destructive_sql"),
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => ({
      title: "Write down the rollback path for this migration",
      description:
        `${Math.round(f(ctx, "migration_files_changed"))} migration ` +
        `${f(ctx, "migration_files_changed") === 1 ? "file" : "files"} changed. Confirm the migration ` +
        `is backward-compatible with the currently deployed application version, so a rollback of the ` +
        `code alone does not break the running system.`,
      rationale:
        "Migrations and application code deploy at slightly different moments. A migration that " +
        "assumes the new code is already live creates a window where the old code is broken.",
    }),
    targets: (ctx) => ({ files: files(ctx, "migration_files_changed") }),
  },

  // --- dependencies --------------------------------------------------------
  {
    id: "verify-dependency-upgrade",
    category: "DEPENDENCY",
    effort: "MEDIUM",
    triggeredBy: ["dependency_manifest_changed", "lockfile_churn"],
    when: (ctx) => on(ctx, "dependency_manifest_changed"),
    priority: (ctx) =>
      escalate(f(ctx, "lockfile_churn") > 400 ? "HIGH" : "MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const targets = files(ctx, "dependency_manifest_changed");
      const churn = Math.round(f(ctx, "lockfile_churn"));
      return {
        title: "Check the changelogs for the upgraded dependencies",
        description:
          `${list(targets)} changed` +
          (churn > 0 ? `, moving ${churn.toLocaleString("en-US")} lines of lockfile` : "") +
          `. Review the release notes for breaking changes, and confirm the application still ` +
          `builds and its tests pass against the new versions rather than relying on the lockfile ` +
          `resolving cleanly.`,
        rationale:
          "A dependency upgrade introduces third-party code that no reviewer on this pull request " +
          "has read. Lockfile diffs also hide transitive upgrades that the manifest does not mention.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "dependency_manifest_changed") }),
  },

  // --- API contract --------------------------------------------------------
  {
    id: "check-api-compatibility",
    category: "API_CONTRACT",
    effort: "MEDIUM",
    triggeredBy: ["touches_public_api", "public_api_files_changed"],
    when: (ctx) => on(ctx, "touches_public_api"),
    priority: (ctx) =>
      escalate(f(ctx, "public_api_files_changed") > 3 ? "HIGH" : "MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const targets = files(ctx, "touches_public_api");
      return {
        title: "Confirm existing callers still work against the changed API",
        description:
          `${list(targets)} ${targets.length === 1 ? "changes" : "change"} an exported symbol or ` +
          `route handler. Search for callers outside this pull request, and if the change is not ` +
          `backward-compatible, either keep the old shape available or coordinate the update with ` +
          `its consumers.`,
        rationale:
          "Signature changes to exported code compile fine within this pull request while breaking " +
          "callers elsewhere in the repository, or in other services, that the diff never shows.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "touches_public_api") }),
  },

  // --- security ------------------------------------------------------------
  {
    id: "security-review-auth-change",
    category: "SECURITY",
    effort: "HIGH",
    triggeredBy: ["touches_auth_or_secrets"],
    when: (ctx) => on(ctx, "touches_auth_or_secrets"),
    priority: (ctx) => escalate("HIGH", ctx.riskLevel),
    build: (ctx) => {
      const targets = files(ctx, "touches_auth_or_secrets");
      return {
        title: "Get a second reviewer on the authentication changes",
        description:
          `${list(targets)} ${targets.length === 1 ? "touches" : "touch"} authentication, ` +
          `authorization, session or cryptographic code. Confirm the change does not widen access, ` +
          `and add a test for the negative case — that an unauthorised caller is still rejected.`,
        rationale:
          "Authorization bugs do not announce themselves. They pass tests, cause no errors, and are " +
          "discovered when someone reaches data they should not have.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "touches_auth_or_secrets") }),
  },
  {
    id: "restore-error-handling",
    category: "OBSERVABILITY",
    effort: "LOW",
    triggeredBy: ["removes_error_handling"],
    when: (ctx) => on(ctx, "removes_error_handling"),
    priority: (ctx) => escalate("HIGH", ctx.riskLevel),
    build: (ctx) => {
      const targets = files(ctx, "removes_error_handling");
      return {
        title: "Check whether the removed error handling is still needed",
        description:
          `The diff deletes a try/catch or error branch in ${list(targets)}. If the failure it ` +
          `guarded against is still possible, the error will now propagate uncaught. Confirm the ` +
          `removal is deliberate and that the failure is handled somewhere upstream.`,
        rationale:
          "Removing a guard converts a handled, logged failure into an unhandled one — turning a " +
          "degraded response into an outage.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "removes_error_handling") }),
  },

  // --- scope ---------------------------------------------------------------
  {
    id: "split-oversized-pr",
    category: "SCOPE",
    effort: "HIGH",
    triggeredBy: ["total_churn", "files_changed", "churn_vs_repo_median"],
    when: (ctx) =>
      (f(ctx, "total_churn") >= 800 || f(ctx, "files_changed") >= 30) &&
      f(ctx, "generated_files_changed") < f(ctx, "files_changed") * 0.5,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const ratio = f(ctx, "churn_vs_repo_median");
      const comparison =
        ratio > 1.5
          ? ` That is roughly ${Math.round(ratio)}x the size of a typical pull request in this repository.`
          : "";
      return {
        title: "Consider splitting this pull request",
        description:
          `${Math.round(f(ctx, "total_churn")).toLocaleString("en-US")} lines across ` +
          `${Math.round(f(ctx, "files_changed"))} files in ${Math.round(f(ctx, "modules_touched"))} modules.` +
          comparison +
          ` Separating the mechanical changes from the behavioural ones would make both reviewable, ` +
          `and make a revert surgical rather than wholesale.`,
        rationale:
          "Review quality falls off sharply with size. A large diff is also a large revert, which " +
          "makes rolling back a single mistake expensive.",
      };
    },
    targets: (ctx) => ({
      modules: ctx.modules.filter((m) => m.module !== "(root)").map((m) => m.module).slice(0, 6),
    }),
  },
  {
    id: "review-cross-module-change",
    category: "CODE_REVIEW",
    effort: "MEDIUM",
    triggeredBy: ["cross_module_change", "modules_touched"],
    when: (ctx) => f(ctx, "modules_touched") >= 4 && f(ctx, "total_churn") < 800,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const modules = ctx.modules.filter((m) => m.module !== "(root)");
      return {
        title: "Involve a reviewer from each affected area",
        description:
          `The change spans ${modules.length} modules: ${list(modules.map((m) => m.module), 6)}. ` +
          `Whoever owns ${modules[0]?.module} may not know what ${modules[1]?.module} expects. ` +
          `Request review from someone familiar with each.`,
        rationale:
          "Cross-module changes fail at the seams, where each side is individually correct but the " +
          "assumptions between them no longer match.",
      };
    },
    targets: (ctx) => ({
      modules: ctx.modules.filter((m) => m.module !== "(root)").map((m) => m.module),
    }),
  },
  {
    id: "review-file-deletions",
    category: "CODE_REVIEW",
    effort: "LOW",
    triggeredBy: ["files_removed", "files_renamed"],
    when: (ctx) => f(ctx, "files_removed") >= 3 || f(ctx, "files_renamed") >= 5,
    priority: (ctx) => escalate("LOW", ctx.riskLevel),
    build: (ctx) => {
      const removed = Math.round(f(ctx, "files_removed"));
      const renamed = Math.round(f(ctx, "files_renamed"));
      const parts: string[] = [];
      if (removed > 0) parts.push(`${removed} deleted`);
      if (renamed > 0) parts.push(`${renamed} renamed or moved`);
      return {
        title: "Search for references to the moved and deleted files",
        description:
          `${parts.join(" and ")}. Grep for the old paths across the repository — dynamic imports, ` +
          `build configuration, CI workflows and documentation links do not fail at compile time.`,
        rationale:
          "The compiler catches broken static imports. It does not catch a path string in a config " +
          "file, a Dockerfile COPY, or a documentation link.",
      };
    },
    targets: (ctx) => ({
      files: [...files(ctx, "files_removed"), ...files(ctx, "files_renamed")].slice(0, 10),
    }),
  },

  // --- configuration & infra ----------------------------------------------
  {
    id: "verify-config-change",
    category: "CONFIGURATION",
    effort: "LOW",
    triggeredBy: ["config_files_changed"],
    when: (ctx) => f(ctx, "config_files_changed") > 0,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const targets = files(ctx, "config_files_changed");
      return {
        title: "Verify the configuration change against a real environment",
        description:
          `${list(targets)} changed. Configuration takes effect the moment it deploys and is rarely ` +
          `covered by tests. Confirm the new values are valid in staging, and that every environment ` +
          `has the variables this change expects.`,
        rationale:
          "Configuration errors bypass the test suite entirely and usually surface as a total " +
          "failure to start rather than a subtle bug.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "config_files_changed") }),
  },
  {
    id: "verify-infra-change",
    category: "ROLLOUT",
    effort: "MEDIUM",
    triggeredBy: ["infra_files_changed"],
    when: (ctx) => f(ctx, "infra_files_changed") > 0,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const targets = files(ctx, "infra_files_changed");
      return {
        title: "Dry-run the deployment pipeline change",
        description:
          `${list(targets)} ${targets.length === 1 ? "changes" : "change"} how the application is ` +
          `built or deployed. A mistake here breaks the deploy itself, which also blocks the fix. ` +
          `Exercise it on a branch or a staging target before merging.`,
        rationale:
          "When the deployment pipeline is broken, the usual remedy — ship a fix — is unavailable.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "infra_files_changed") }),
  },

  // --- history-driven ------------------------------------------------------
  {
    id: "extra-care-incident-prone-modules",
    category: "ROLLOUT",
    effort: "MEDIUM",
    triggeredBy: ["module_incident_history"],
    when: (ctx) => f(ctx, "module_incident_history") >= 0.3,
    priority: (ctx) => escalate("HIGH", ctx.riskLevel),
    build: (ctx) => {
      const pct = Math.round(f(ctx, "module_incident_history") * 100);
      const modules = ctx.modules.filter((m) => m.module !== "(root)").slice(0, 3);
      return {
        title: "Roll this out gradually — these modules have caused incidents before",
        description:
          `${pct}% of previously reported incidents in this repository involved the modules this ` +
          `pull request touches (${list(modules.map((m) => m.module))}). Deploy behind a flag or to a ` +
          `subset of traffic first, and watch the relevant dashboards before completing the rollout.`,
        rationale:
          "This is the strongest historical signal BugDNA has, because it comes from outcomes a " +
          "human confirmed rather than from anything the model inferred.",
      };
    },
    targets: (ctx) => ({
      modules: ctx.modules.filter((m) => m.module !== "(root)").map((m) => m.module).slice(0, 5),
    }),
  },
  {
    id: "pair-with-module-owner",
    category: "CODE_REVIEW",
    effort: "LOW",
    triggeredBy: ["author_module_familiarity", "author_pr_count_90d"],
    when: (ctx) =>
      f(ctx, "author_module_familiarity") < 0.34 &&
      f(ctx, "modules_touched") > 0 &&
      f(ctx, "total_churn") >= 100,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => {
      const pct = Math.round(f(ctx, "author_module_familiarity") * 100);
      const modules = ctx.modules.filter((m) => m.module !== "(root)").slice(0, 3);
      return {
        title: "Ask someone who knows this code to review it",
        description:
          `${ctx.pullRequest.authorLogin} has previously changed ${pct}% of the modules in this pull ` +
          `request. Request review from a regular contributor to ` +
          `${list(modules.map((m) => m.module))} — the implicit constraints in unfamiliar code are ` +
          `exactly what a diff does not show.`,
        rationale:
          "Editing unfamiliar code is a well-understood source of defects, and it is cheap to " +
          "mitigate with the right reviewer.",
      };
    },
    targets: (ctx) => ({
      modules: ctx.modules.filter((m) => m.module !== "(root)").map((m) => m.module).slice(0, 5),
    }),
  },
  {
    id: "staged-rollout-unreliable-repo",
    category: "ROLLOUT",
    effort: "MEDIUM",
    triggeredBy: ["repo_deployment_failure_rate_90d"],
    when: (ctx) => f(ctx, "repo_deployment_failure_rate_90d") >= 0.25,
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => ({
      title: "Plan for a rollback before deploying",
      description:
        `${Math.round(f(ctx, "repo_deployment_failure_rate_90d") * 100)}% of recorded deployments for ` +
        `this repository failed or were rolled back in the last 90 days. Confirm you can roll back ` +
        `quickly, and avoid shipping this alongside other changes so a failure is attributable.`,
      rationale:
        "In a repository that ships unreliably, the probability that any given deploy needs " +
        "reverting is already high, independent of this change.",
    }),
  },

  // --- hygiene -------------------------------------------------------------
  {
    id: "describe-the-change",
    category: "DOCUMENTATION",
    effort: "LOW",
    triggeredBy: ["has_description", "description_length"],
    when: (ctx) => !on(ctx, "has_description") && f(ctx, "total_churn") >= 100,
    priority: () => "LOW",
    build: (ctx) => ({
      title: "Add a description explaining the change",
      description:
        `A ${Math.round(f(ctx, "total_churn"))}-line change was opened with no description. A short ` +
        `note on what changed, why, and how it was verified measurably improves the review it gets.`,
      rationale:
        "Reviewers reconstruct intent from the diff when it is not stated. That is slow, and they " +
        "sometimes reconstruct it wrongly.",
    }),
  },
  {
    id: "resolve-todo-markers",
    category: "CODE_REVIEW",
    effort: "LOW",
    triggeredBy: ["adds_todo_markers"],
    when: (ctx) => on(ctx, "adds_todo_markers"),
    priority: () => "LOW",
    build: (ctx) => {
      const targets = files(ctx, "adds_todo_markers");
      return {
        title: "Decide whether the new TODO markers block this merge",
        description:
          `New TODO/FIXME markers were added in ${list(targets)}. Either resolve them, or record ` +
          `them as follow-up work so they are not forgotten once this ships.`,
        rationale:
          "A TODO added during review is an acknowledged gap. Tracked, it is a plan; untracked, it " +
          "is a defect waiting to be rediscovered.",
      };
    },
    targets: (ctx) => ({ files: files(ctx, "adds_todo_markers") }),
  },
  {
    id: "await-review-before-merge",
    category: "CODE_REVIEW",
    effort: "LOW",
    triggeredBy: ["review_comments_count", "total_churn"],
    when: (ctx) =>
      f(ctx, "review_comments_count") === 0 &&
      f(ctx, "total_churn") >= 400 &&
      !on(ctx, "is_draft") &&
      !on(ctx, "docs_only_change"),
    priority: (ctx) => escalate("MEDIUM", ctx.riskLevel),
    build: (ctx) => ({
      title: "Get a review before merging",
      description:
        `A ${Math.round(f(ctx, "total_churn")).toLocaleString("en-US")}-line change has no review ` +
        `comments yet. Nobody has examined this code.`,
      rationale:
        "Review is the cheapest defect-detection available, and its absence on a large change is a " +
        "process gap rather than a code problem.",
    }),
  },
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/**
 * Evaluate every rule against the analysis and return the ones that fired.
 *
 * A rule throwing is contained: a bad rule should cost its own recommendation,
 * not the whole analysis.
 */
export function buildRecommendations(
  ctx: RuleContext,
  limit = 8,
): RecommendationDraft[] {
  const drafts: RecommendationDraft[] = [];

  for (const rule of RULES) {
    let fired = false;
    try {
      fired = rule.when(ctx);
    } catch {
      fired = false;
    }
    if (!fired) continue;

    try {
      const { title, description, rationale } = rule.build(ctx);
      drafts.push({
        ruleId: rule.id,
        title,
        description,
        rationale,
        category: rule.category,
        priority: rule.priority(ctx),
        effort: rule.effort,
        // Only report keys that are actually in the feature vector, so the audit
        // trail cannot reference a signal that was not computed.
        triggeredByFactorKeys: rule.triggeredBy.filter((k) => k in ctx.features),
        targets: rule.targets?.(ctx) ?? null,
      });
    } catch {
      // Skip a rule whose message could not be built rather than failing.
      continue;
    }
  }

  return drafts
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
    .slice(0, limit);
}

/** Exposed for tests: the rule ids, so coverage can be asserted. */
export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);
