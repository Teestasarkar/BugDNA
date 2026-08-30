/**
 * Risk logic tests.
 *
 * Covers the pure decision-making layers: banding, explanation construction,
 * recommendation rules, token encryption and the tenancy predicate.
 *
 * The recommendation tests are the important ones. The product's credibility
 * rests on advice being *caused* by something in the diff — a rule that fires
 * on every pull request is noise that teaches people to ignore the tool. So
 * these assert both directions: that a rule fires when its signal is present,
 * and that it stays silent when it is not.
 */
import { describe, expect, it } from "vitest";
import { RISK_BANDS, scoreToRiskLevel } from "../src/config/constants";
import { openToken, safeEqual, sealToken } from "../src/lib/crypto";
import { idToString, isoOrNull, round, toBigInt } from "../src/lib/serialize";
import { buildExplanation } from "../src/modules/analysis/explain/explain";
import { buildRecommendations, RULE_IDS } from "../src/modules/analysis/recommend/rules";
import {
  fallbackVector,
  FEATURE_KEYS,
  FEATURE_SPECS,
  formatFeatureValue,
  getFeatureSpec,
} from "../src/modules/analysis/features/registry";
import {
  nestedRepositoryAccessWhere,
  repositoryAccessWhere,
} from "../src/modules/repositories/repository.access";
import type { AuthContext } from "../src/types/express";
import type { MlContribution, MlExplanation } from "../src/modules/ml/ml.types";

// ---------------------------------------------------------------------------
// Banding
// ---------------------------------------------------------------------------

describe("scoreToRiskLevel", () => {
  it("maps each band, including its boundaries", () => {
    expect(scoreToRiskLevel(0)).toBe("LOW");
    expect(scoreToRiskLevel(34)).toBe("LOW");
    expect(scoreToRiskLevel(35)).toBe("MODERATE");
    expect(scoreToRiskLevel(59)).toBe("MODERATE");
    expect(scoreToRiskLevel(60)).toBe("HIGH");
    expect(scoreToRiskLevel(79)).toBe("HIGH");
    expect(scoreToRiskLevel(80)).toBe("CRITICAL");
    expect(scoreToRiskLevel(100)).toBe("CRITICAL");
  });

  it("clamps values outside 0-100 rather than throwing", () => {
    expect(scoreToRiskLevel(-10)).toBe("LOW");
    expect(scoreToRiskLevel(250)).toBe("CRITICAL");
  });

  it("has bands that are contiguous and cover 0-100 exactly", () => {
    // A gap would leave a score unbanded; an overlap would make the label
    // ambiguous. Both are silent failures.
    const sorted = [...RISK_BANDS].sort((a, b) => a.min - b.min);
    expect(sorted[0]?.min).toBe(0);
    expect(sorted[sorted.length - 1]?.max).toBe(100);

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]?.min).toBe((sorted[i - 1]?.max ?? 0) + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

describe("feature registry", () => {
  it("has unique lower_snake_case keys", () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
    for (const key of FEATURE_KEYS) {
      expect(key, `${key} must be lower_snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every feature a human label and a description", () => {
    // These are shown directly to a developer; an empty one would render as a
    // blank row in the explanation.
    for (const spec of FEATURE_SPECS) {
      expect(spec.label.length, `${spec.key} needs a label`).toBeGreaterThan(2);
      expect(spec.description.length, `${spec.key} needs a description`).toBeGreaterThan(20);
    }
  });

  it("produces a complete, finite fallback vector", () => {
    const vector = fallbackVector();
    expect(Object.keys(vector).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const [key, value] of Object.entries(vector)) {
      expect(Number.isFinite(value), `${key} fallback must be finite`).toBe(true);
    }
  });

  it("formats values the way a developer reads them", () => {
    expect(formatFeatureValue("touches_tests", 1)).toBe("Yes");
    expect(formatFeatureValue("touches_tests", 0)).toBe("No");
    expect(formatFeatureValue("test_to_source_ratio", 0.65)).toBe("65%");
    expect(formatFeatureValue("total_churn", 1030)).toBe("1,030 lines");
    expect(formatFeatureValue("files_changed", 34)).toBe("34 files");
    expect(formatFeatureValue("pr_age_hours", 12)).toBe("12h");
    expect(formatFeatureValue("pr_age_hours", 72)).toBe("3d");
  });

  it("marks history-dependent features so the UI can disclose them", () => {
    const historical = FEATURE_SPECS.filter((s) => s.requiresHistory);
    expect(historical.length).toBeGreaterThan(0);
    // These are the ones that fall back to neutral values on a fresh repo.
    expect(historical.map((s) => s.key)).toContain("module_incident_history");
  });
});

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

function contribution(key: string, shap: number, value: number): MlContribution {
  return { key, shap_value: shap, feature_value: value, contribution: 0 };
}

const explanationStub: MlExplanation = {
  base_value: -0.82,
  contributions: [],
  method: "shap_tree",
  notes: [],
};

describe("buildExplanation", () => {
  const pullRequest = { number: 431, authorLogin: "marcus-lee", title: "ledger migration" };

  it("ranks factors by absolute influence, not by sign", () => {
    const result = buildExplanation({
      contributions: [
        contribution("touches_tests", -0.9, 0),
        contribution("has_destructive_sql", 0.4, 1),
        contribution("total_churn", 0.2, 1030),
      ],
      features: { touches_tests: 0, has_destructive_sql: 1, total_churn: 1030 },
      evidence: {},
      explanation: explanationStub,
      riskScore: 72,
      riskLevel: "HIGH",
      pullRequest,
      scoredBy: "MODEL",
      degradedReasons: [],
    });

    // The strongest factor is risk-reducing; it must still rank first.
    expect(result.factors[0]?.key).toBe("touches_tests");
    expect(result.factors[0]?.direction).toBe("DECREASES_RISK");
    expect(result.factors[1]?.key).toBe("has_destructive_sql");
  });

  it("normalises contributions to shares that sum to about 100", () => {
    const result = buildExplanation({
      contributions: [
        contribution("has_destructive_sql", 0.5, 1),
        contribution("total_churn", 0.3, 1030),
        contribution("modules_touched", 0.2, 8),
      ],
      features: {},
      evidence: {},
      explanation: explanationStub,
      riskScore: 72,
      riskLevel: "HIGH",
      pullRequest,
      scoredBy: "MODEL",
      degradedReasons: [],
    });

    const total = result.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(total).toBeGreaterThan(97);
    expect(total).toBeLessThan(103);
  });

  it("drops negligible contributions as noise", () => {
    const result = buildExplanation({
      contributions: [
        contribution("has_destructive_sql", 1.0, 1),
        // 0.1% of the total — not a reason, and listing it would pad the UI.
        contribution("commits_count", 0.001, 3),
      ],
      features: {},
      evidence: {},
      explanation: explanationStub,
      riskScore: 72,
      riskLevel: "HIGH",
      pullRequest,
      scoredBy: "MODEL",
      degradedReasons: [],
    });

    expect(result.factors.map((f) => f.key)).not.toContain("commits_count");
  });

  it("attaches evidence files to the factor that caused them", () => {
    const result = buildExplanation({
      contributions: [contribution("dependency_manifest_changed", 0.5, 1)],
      features: { dependency_manifest_changed: 1 },
      evidence: {
        dependency_manifest_changed: { files: ["package.json", "package-lock.json"] },
      },
      explanation: explanationStub,
      riskScore: 45,
      riskLevel: "MODERATE",
      pullRequest,
      scoredBy: "MODEL",
      degradedReasons: [],
    });

    expect(result.factors[0]?.evidence?.files).toEqual([
      "package.json",
      "package-lock.json",
    ]);
  });

  it("writes a summary that names the actual drivers", () => {
    const result = buildExplanation({
      contributions: [
        contribution("has_destructive_sql", 0.8, 1),
        contribution("touches_tests", 0.5, 0),
      ],
      features: { total_churn: 1030, files_changed: 34, modules_touched: 8 },
      evidence: {},
      explanation: explanationStub,
      riskScore: 72,
      riskLevel: "HIGH",
      pullRequest,
      scoredBy: "MODEL",
      degradedReasons: [],
    });

    expect(result.summary).toContain("72");
    expect(result.summary).toContain("1,030");
    expect(result.summary).toContain("destructive schema changes");
    // The phrasing must read naturally, not as a key dump.
    expect(result.summary).not.toContain("has_destructive_sql");
  });

  it("discloses heuristic scoring in the summary", () => {
    const result = buildExplanation({
      contributions: [contribution("total_churn", 0.4, 500)],
      features: { total_churn: 500, files_changed: 12, modules_touched: 3 },
      evidence: {},
      explanation: { ...explanationStub, method: "heuristic_weights" },
      riskScore: 50,
      riskLevel: "MODERATE",
      pullRequest,
      scoredBy: "HEURISTIC",
      degradedReasons: [],
    });

    expect(result.summary).toMatch(/rule-based|not a trained model/i);
  });

  it("survives an empty contribution list", () => {
    const result = buildExplanation({
      contributions: [],
      features: { total_churn: 4, files_changed: 2, modules_touched: 1 },
      evidence: {},
      explanation: explanationStub,
      riskScore: 8,
      riskLevel: "LOW",
      pullRequest,
      scoredBy: "MODEL",
      degradedReasons: [],
    });

    expect(result.factors).toEqual([]);
    expect(result.summary).toContain("No individual signal");
  });
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function ruleContext(features: Record<string, number>, overrides = {}) {
  return {
    features: { ...fallbackVector(), ...features },
    evidence: {},
    factors: [],
    riskLevel: "MODERATE" as const,
    riskScore: 50,
    modules: [{ module: "payments", churn: 400, files: 8 }],
    pullRequest: { number: 431, authorLogin: "marcus-lee", title: "change" },
    ...overrides,
  };
}

describe("buildRecommendations", () => {
  it("emits nothing for a clean, small, well-tested change", () => {
    // An empty list is the correct output here. Filler advice on every PR is
    // what makes people stop reading.
    const result = buildRecommendations(
      ruleContext({
        total_churn: 30,
        files_changed: 2,
        source_files_changed: 1,
        touches_tests: 1,
        test_files_changed: 1,
        test_to_source_ratio: 0.8,
        has_description: 1,
        description_length: 300,
        review_comments_count: 4,
        modules_touched: 1,
        max_module_concentration: 1,
        author_module_familiarity: 1,
        author_pr_count_90d: 20,
      }),
    );

    expect(result).toEqual([]);
  });

  it("asks for tests when a behavioural change has none", () => {
    const result = buildRecommendations(
      ruleContext({
        total_churn: 400,
        files_changed: 12,
        source_files_changed: 12,
        touches_tests: 0,
        author_module_familiarity: 1,
      }),
    );

    expect(result.map((r) => r.ruleId)).toContain("add-tests-for-untested-change");
  });

  it("does not ask for tests when tests are already included", () => {
    const result = buildRecommendations(
      ruleContext({
        total_churn: 400,
        files_changed: 12,
        source_files_changed: 10,
        touches_tests: 1,
        test_files_changed: 3,
        test_to_source_ratio: 0.5,
        author_module_familiarity: 1,
      }),
    );

    expect(result.map((r) => r.ruleId)).not.toContain("add-tests-for-untested-change");
  });

  it("treats destructive SQL as critical priority", () => {
    const result = buildRecommendations(
      ruleContext({ has_destructive_sql: 1, migration_files_changed: 2 }),
    );

    const rule = result.find((r) => r.ruleId === "review-destructive-schema-change");
    expect(rule).toBeDefined();
    expect(rule?.priority).toBe("CRITICAL");
    expect(rule?.category).toBe("DATABASE");
  });

  it("asks for a rollback plan on a non-destructive migration instead", () => {
    // The two migration rules are mutually exclusive; emitting both would be
    // redundant advice about the same file.
    const result = buildRecommendations(
      ruleContext({ migration_files_changed: 1, has_destructive_sql: 0 }),
    );

    const ids = result.map((r) => r.ruleId);
    expect(ids).toContain("plan-migration-rollback");
    expect(ids).not.toContain("review-destructive-schema-change");
  });

  it("escalates priority when the overall assessment is severe", () => {
    const moderate = buildRecommendations(
      ruleContext({ config_files_changed: 2 }, { riskLevel: "MODERATE" }),
    ).find((r) => r.ruleId === "verify-config-change");

    const critical = buildRecommendations(
      ruleContext({ config_files_changed: 2 }, { riskLevel: "CRITICAL" }),
    ).find((r) => r.ruleId === "verify-config-change");

    expect(moderate?.priority).toBe("MEDIUM");
    expect(critical?.priority).toBe("HIGH");
  });

  it("records the feature keys that triggered each recommendation", () => {
    // This is the audit trail from "why is it risky" to "what should I do".
    const result = buildRecommendations(
      ruleContext({ dependency_manifest_changed: 1, lockfile_churn: 900 }),
    );

    const rule = result.find((r) => r.ruleId === "verify-dependency-upgrade");
    expect(rule?.triggeredByFactorKeys).toContain("dependency_manifest_changed");
  });

  it("only reports trigger keys that exist in the feature vector", () => {
    const result = buildRecommendations(ruleContext({ has_destructive_sql: 1 }));
    for (const rule of result) {
      for (const key of rule.triggeredByFactorKeys) {
        expect(FEATURE_KEYS, `${key} is not a real feature`).toContain(key);
      }
    }
  });

  it("orders by priority, most severe first", () => {
    const result = buildRecommendations(
      ruleContext({
        has_destructive_sql: 1,
        migration_files_changed: 2,
        touches_auth_or_secrets: 1,
        total_churn: 1200,
        files_changed: 40,
        source_files_changed: 40,
        touches_tests: 0,
        has_description: 0,
      }),
    );

    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
    for (let i = 1; i < result.length; i++) {
      expect(order[result[i]!.priority]).toBeGreaterThanOrEqual(
        order[result[i - 1]!.priority],
      );
    }
  });

  it("respects the limit", () => {
    const result = buildRecommendations(
      ruleContext({
        has_destructive_sql: 1,
        migration_files_changed: 2,
        touches_auth_or_secrets: 1,
        removes_error_handling: 1,
        total_churn: 2000,
        files_changed: 60,
        source_files_changed: 60,
        touches_tests: 0,
        has_description: 0,
        config_files_changed: 3,
        infra_files_changed: 2,
        modules_touched: 9,
        dependency_manifest_changed: 1,
      }),
      3,
    );

    expect(result).toHaveLength(3);
  });

  it("has unique rule ids", () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });
});

// ---------------------------------------------------------------------------
// Token encryption
// ---------------------------------------------------------------------------

describe("token encryption", () => {
  it("round-trips a token", () => {
    const secret = "gho_averyrealisticlookinggithubtoken1234567890";
    expect(openToken(sealToken(secret))).toBe(secret);
  });

  it("produces a different ciphertext each time", () => {
    // A reused IV would leak that two users share a token.
    const a = sealToken("same-token");
    const b = sealToken("same-token");
    expect(a.cipher).not.toBe(b.cipher);
    expect(a.iv).not.toBe(b.iv);
  });

  it("refuses to encrypt an empty value", () => {
    expect(() => sealToken("")).toThrow();
  });

  it("fails to decrypt tampered ciphertext rather than returning garbage", () => {
    // This is why GCM: authentication, not just confidentiality.
    const sealed = sealToken("gho_token");
    const tampered = {
      ...sealed,
      cipher: Buffer.from("tampered-payload").toString("base64"),
    };
    expect(() => openToken(tampered)).toThrow();
  });

  it("fails to decrypt when the auth tag is wrong", () => {
    const sealed = sealToken("gho_token");
    const tampered = { ...sealed, tag: Buffer.alloc(16).toString("base64") };
    expect(() => openToken(tampered)).toThrow();
  });

  it("compares secrets in constant time without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcdef")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenancy predicate
// ---------------------------------------------------------------------------

describe("repositoryAccessWhere", () => {
  const base: AuthContext = {
    userId: "user-1",
    sessionId: "session-1",
    githubLogin: "octocat",
    teamIds: [],
    isDemo: false,
  };

  it("restricts to owned repositories when the user has no teams", () => {
    const where = repositoryAccessWhere(base);
    expect(where.OR).toEqual([{ ownerUserId: "user-1" }]);
  });

  it("adds the team clause when the user has teams", () => {
    const where = repositoryAccessWhere({ ...base, teamIds: ["team-1", "team-2"] });
    expect(where.OR).toEqual([
      { ownerUserId: "user-1" },
      { teamId: { in: ["team-1", "team-2"] } },
    ]);
  });

  it("never produces an unbounded predicate", () => {
    // An empty OR would match every row in the table. That is the single worst
    // failure this function could have.
    for (const teamIds of [[], ["t1"], ["t1", "t2", "t3"]]) {
      const where = repositoryAccessWhere({ ...base, teamIds });
      expect(Array.isArray(where.OR)).toBe(true);
      expect((where.OR as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("nests correctly for child models", () => {
    const where = nestedRepositoryAccessWhere(base);
    expect(where.repository.OR).toEqual([{ ownerUserId: "user-1" }]);
  });
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe("serialisation helpers", () => {
  it("renders BigInt ids as strings to preserve precision", () => {
    // GitHub ids exceed Number.MAX_SAFE_INTEGER.
    const big = 9007199254740993n;
    expect(idToString(big)).toBe("9007199254740993");
    // Round-tripping through a JS number drops the final digit — which is
    // precisely why the API serialises these as strings. (Comparing against a
    // numeric literal here would not work: the literal loses the digit too.)
    expect(String(Number(idToString(big)))).toBe("9007199254740992");
  });

  it("handles nullish ids", () => {
    expect(idToString(null)).toBeNull();
    expect(idToString(undefined)).toBeNull();
  });

  it("parses ids back to BigInt", () => {
    expect(toBigInt("42")).toBe(42n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt(42n)).toBe(42n);
  });

  it("formats dates as ISO or null", () => {
    expect(isoOrNull(new Date("2026-08-31T00:00:00Z"))).toBe("2026-08-31T00:00:00.000Z");
    expect(isoOrNull(null)).toBeNull();
  });

  it("rounds, preserving null", () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(null)).toBeNull();
    expect(round(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registry lookups
// ---------------------------------------------------------------------------

describe("getFeatureSpec", () => {
  it("finds a known feature", () => {
    expect(getFeatureSpec("has_destructive_sql")?.category).toBe("DATA_LAYER");
  });

  it("returns undefined for an unknown key rather than throwing", () => {
    expect(getFeatureSpec("not_a_feature")).toBeUndefined();
  });
});
