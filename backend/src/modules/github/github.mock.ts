/**
 * Deterministic GitHub fixtures.
 *
 * Purpose: let the whole product — sign-in, repository selection, PR discovery,
 * diff ingestion, feature extraction, scoring, explanation — run with no
 * network and no credentials. That matters for three things:
 *
 *  - **demos**, which must not depend on a rate limit or a WiFi connection;
 *  - **tests**, which need a stable diff to assert feature extraction against;
 *  - **the seeded tenant**, so a fresh install has something to look at.
 *
 * Everything is derived from a seeded PRNG keyed by repository and PR number,
 * so the same PR always produces the same diff. The archetypes below are chosen
 * to span the risk spectrum: a docs typo should score LOW and a destructive
 * migration with no tests should score CRITICAL. If the pipeline ever stops
 * distinguishing them, the fixtures make that obvious immediately.
 *
 * These fixtures are **not** training data. No model is fitted on them; they
 * only exercise the code path. See docs/ML_MODEL.md.
 */
import type {
  GhDeployment,
  GhEmail,
  GhOAuthTokenResponse,
  GhPullRequestDetail,
  GhPullRequestFile,
  GhPullRequestSummary,
  GhRepository,
  GhUser,
  GitHubProvider,
  Paged,
} from "./github.types";

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for fixtures, fully deterministic. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
        a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

const between = (rand: () => number, min: number, max: number): number =>
  Math.floor(rand() * (max - min + 1)) + min;

/** Fixed clock origin so timestamps are stable across runs. */
const EPOCH = Date.parse("2026-08-01T09:00:00.000Z");
const daysAgo = (n: number): string => new Date(EPOCH - n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

const MOCK_OWNER = "bugdna-demo";

interface MockRepoSpec {
  id: number;
  name: string;
  description: string;
  language: string;
  private: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  sizeKb: number;
  prCount: number;
}

const MOCK_REPOS: readonly MockRepoSpec[] = [
  {
    id: 900_100_001,
    name: "payments-api",
    description:
      "Billing and payment orchestration service. Handles charges, refunds and webhook reconciliation.",
    language: "TypeScript",
    private: true,
    stars: 34,
    forks: 6,
    openIssues: 11,
    sizeKb: 48_200,
    prCount: 9,
  },
  {
    id: 900_100_002,
    name: "checkout-web",
    description: "Customer-facing checkout flow built with Next.js.",
    language: "TypeScript",
    private: false,
    stars: 128,
    forks: 22,
    openIssues: 7,
    sizeKb: 31_400,
    prCount: 8,
  },
  {
    id: 900_100_003,
    name: "risk-ml-platform",
    description: "Feature store and model-serving infrastructure for fraud scoring.",
    language: "Python",
    private: true,
    stars: 61,
    forks: 9,
    openIssues: 18,
    sizeKb: 76_900,
    prCount: 7,
  },
];

function toGhRepository(spec: MockRepoSpec): GhRepository {
  return {
    id: spec.id,
    name: spec.name,
    full_name: `${MOCK_OWNER}/${spec.name}`,
    private: spec.private,
    description: spec.description,
    html_url: `https://github.com/${MOCK_OWNER}/${spec.name}`,
    homepage: null,
    default_branch: "main",
    language: spec.language,
    stargazers_count: spec.stars,
    forks_count: spec.forks,
    open_issues_count: spec.openIssues,
    size: spec.sizeKb,
    archived: false,
    disabled: false,
    fork: false,
    created_at: daysAgo(640),
    updated_at: daysAgo(1),
    pushed_at: daysAgo(1),
    permissions: { admin: true, push: true, pull: true },
    owner: {
      id: 900_000_001,
      login: MOCK_OWNER,
      avatar_url: `https://avatars.githubusercontent.com/u/9000001?v=4`,
      type: "Organization",
    },
  };
}

// ---------------------------------------------------------------------------
// PR archetypes
// ---------------------------------------------------------------------------
// Each archetype describes a *kind* of change, and generates a file list whose
// paths and patch content carry the signals the feature extractor looks for.

interface FileSpec {
  filename: string;
  status: GhPullRequestFile["status"];
  additions: number;
  deletions: number;
  patch?: string;
}

interface Archetype {
  key: string;
  titles: readonly string[];
  bodyTemplate: string;
  labels: readonly string[];
  branchPrefix: string;
  /** Author pool, so "author familiarity" style features have variety. */
  authors: readonly string[];
  files: (rand: () => number, repo: MockRepoSpec) => FileSpec[];
}

const DIFF = {
  docsTypo: `@@ -12,7 +12,7 @@ Configure the service with:

 \`\`\`bash
-export PAYMENTS_API_URL=htp://localhost:4000
+export PAYMENTS_API_URL=http://localhost:4000
 \`\`\`

 Then run the migrations.`,

  featureHandler: `@@ -1,6 +1,7 @@
 import { Router } from "express";
 import { z } from "zod";
+import { computeProration } from "../billing/proration";

 const router = Router();

@@ -24,6 +25,24 @@ router.get("/subscriptions/:id", async (req, res) => {
   res.json(subscription);
 });

+const upgradeSchema = z.object({
+  planId: z.string().min(1),
+  effectiveAt: z.string().datetime().optional(),
+});
+
+router.post("/subscriptions/:id/upgrade", async (req, res) => {
+  const input = upgradeSchema.parse(req.body);
+  const subscription = await findSubscription(req.params.id);
+  if (!subscription) return res.status(404).json({ error: "not_found" });
+
+  const proration = computeProration(subscription, input.planId, input.effectiveAt);
+  const updated = await applyUpgrade(subscription, input.planId, proration);
+
+  res.status(200).json({ subscription: updated, proration });
+});
+
 export default router;`,

  featureTest: `@@ -0,0 +1,38 @@
+import { describe, expect, it } from "vitest";
+import { computeProration } from "../src/billing/proration";
+
+describe("computeProration", () => {
+  it("charges the difference for a mid-cycle upgrade", () => {
+    const result = computeProration(subscriptionFixture, "plan_pro", "2026-08-15T00:00:00Z");
+    expect(result.amountCents).toBe(1_450);
+    expect(result.creditCents).toBe(0);
+  });
+
+  it("issues credit when downgrading", () => {
+    const result = computeProration(proSubscription, "plan_basic", "2026-08-15T00:00:00Z");
+    expect(result.creditCents).toBeGreaterThan(0);
+  });
+
+  it("returns zero for a same-plan change", () => {
+    const result = computeProration(subscriptionFixture, "plan_basic");
+    expect(result.amountCents).toBe(0);
+  });
+});`,

  lockfileBump: `@@ -1042,9 +1042,9 @@
     "integrity": "sha512-oldhasholdhasholdhash=="
     },
     "node_modules/stripe": {
-      "version": "14.21.0",
-      "resolved": "https://registry.npmjs.org/stripe/-/stripe-14.21.0.tgz",
-      "integrity": "sha512-aaaaaaaaaaaaaaaaaaaa=="
+      "version": "17.4.0",
+      "resolved": "https://registry.npmjs.org/stripe/-/stripe-17.4.0.tgz",
+      "integrity": "sha512-bbbbbbbbbbbbbbbbbbbb=="
     },`,

  packageJsonBump: `@@ -18,9 +18,9 @@
   "dependencies": {
     "express": "^5.1.0",
-    "stripe": "^14.21.0",
-    "pg": "^8.11.3",
+    "stripe": "^17.4.0",
+    "pg": "^8.13.1",
     "zod": "^3.25.0"
   },`,

  destructiveMigration: `@@ -0,0 +1,14 @@
+-- Consolidate legacy payment columns into the new ledger model.
+
+ALTER TABLE "payments" DROP COLUMN "legacy_reference";
+ALTER TABLE "payments" DROP COLUMN "gateway_blob";
+
+ALTER TABLE "payments" ADD COLUMN "ledger_entry_id" TEXT NOT NULL;
+
+CREATE INDEX "payments_ledger_entry_id_idx" ON "payments"("ledger_entry_id");
+
+DROP TABLE "payment_legacy_audit";
+
+ALTER TABLE "invoices" ALTER COLUMN "currency" SET NOT NULL;`,

  schemaChange: `@@ -84,10 +84,12 @@ model Payment {
   id        String   @id @default(cuid())
   amount    Int
-  reference String?
+  ledgerEntryId String
   status    PaymentStatus

+  @@index([ledgerEntryId])
   @@map("payments")
 }`,

  authChange: `@@ -18,23 +18,19 @@ import { verifyToken } from "./jwt";
 export async function authenticate(req, res, next) {
-  try {
-    const token = req.headers.authorization?.slice(7);
-    if (!token) return res.status(401).json({ error: "unauthenticated" });
-
-    const claims = await verifyToken(token);
-    if (!claims) return res.status(401).json({ error: "unauthenticated" });
-
-    req.user = claims;
-    next();
-  } catch (err) {
-    return res.status(401).json({ error: "unauthenticated" });
-  }
+  const token = req.headers.authorization?.slice(7);
+  const claims = await verifyToken(token);
+  req.user = claims;
+  next();
 }

-export function requireRole(role) {
+export function requireRole(role = "member") {
   return (req, res, next) => {
-    if (req.user?.role !== role) return res.status(403).json({ error: "forbidden" });
+    // TODO: re-enable strict role checking once the migration completes
     next();
   };
 }`,

  refactorModule: `@@ -1,18 +1,22 @@
-import { LegacyGateway } from "./legacy-gateway";
+import { PaymentGateway } from "./gateway";
+import { retry } from "../lib/retry";

-export class ChargeService {
-  constructor(private gateway: LegacyGateway) {}
+export class ChargeService {
+  constructor(private gateway: PaymentGateway) {}

-  async charge(amount: number, token: string) {
-    return this.gateway.submit({ amount, token });
+  async charge(amount: number, token: string, idempotencyKey: string) {
+    return retry(() => this.gateway.submit({ amount, token, idempotencyKey }), {
+      attempts: 3,
+    });
   }
 }`,

  configChange: `@@ -8,10 +8,14 @@ services:
   api:
     environment:
-      DATABASE_POOL_SIZE: 10
-      REQUEST_TIMEOUT_MS: 30000
+      DATABASE_POOL_SIZE: 40
+      REQUEST_TIMEOUT_MS: 5000
+      ENABLE_NEW_LEDGER: "true"
+    deploy:
+      replicas: 4`,

  infraChange: `@@ -22,7 +22,7 @@ jobs:
       - name: Deploy
         run: |
-          ssh $HOST "cd /srv/app && docker compose up -d --build"
+          ssh $HOST "cd /srv/app && docker compose up -d --build --force-recreate"`,

  perfFix: `@@ -34,12 +34,14 @@ export async function listInvoices(customerId: string) {
-  const invoices = await prisma.invoice.findMany({ where: { customerId } });
-  const enriched = [];
-  for (const invoice of invoices) {
-    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
-    enriched.push({ ...invoice, lines });
-  }
-  return enriched;
+  return prisma.invoice.findMany({
+    where: { customerId },
+    include: { lines: true },
+    orderBy: { issuedAt: "desc" },
+  });
 }`,
};

const ARCHETYPES: readonly Archetype[] = [
  {
    key: "docs",
    titles: [
      "docs: fix incorrect API URL in the setup guide",
      "docs: clarify webhook retry semantics",
      "docs: correct typo in environment variable table",
    ],
    bodyTemplate:
      "Small documentation correction spotted while onboarding. No functional change.",
    labels: ["documentation"],
    branchPrefix: "docs",
    authors: ["priya-n", "sam-oyelaran"],
    files: () => [
      { filename: "README.md", status: "modified", additions: 1, deletions: 1, patch: DIFF.docsTypo },
      {
        filename: "docs/webhooks.md",
        status: "modified",
        additions: 6,
        deletions: 2,
        patch: DIFF.docsTypo,
      },
    ],
  },
  {
    key: "feature-with-tests",
    titles: [
      "feat: support mid-cycle subscription upgrades",
      "feat: add proration to plan changes",
      "feat: expose subscription upgrade endpoint",
    ],
    bodyTemplate:
      "Adds the upgrade path requested in #412.\n\n- computes proration\n- new POST /subscriptions/:id/upgrade\n- unit tests for the proration edge cases",
    labels: ["feature"],
    branchPrefix: "feat",
    authors: ["dana-whitfield", "priya-n"],
    files: (rand) => [
      {
        filename: "src/routes/subscriptions.ts",
        status: "modified",
        additions: between(rand, 22, 34),
        deletions: between(rand, 1, 4),
        patch: DIFF.featureHandler,
      },
      {
        filename: "src/billing/proration.ts",
        status: "added",
        additions: between(rand, 48, 72),
        deletions: 0,
        patch: DIFF.featureHandler,
      },
      {
        filename: "tests/proration.test.ts",
        status: "added",
        additions: between(rand, 32, 48),
        deletions: 0,
        patch: DIFF.featureTest,
      },
      {
        filename: "docs/api.md",
        status: "modified",
        additions: 9,
        deletions: 1,
        patch: DIFF.docsTypo,
      },
    ],
  },
  {
    key: "dependency-bump",
    titles: [
      "chore(deps): upgrade stripe to v17 and pg to 8.13",
      "chore(deps): bump payment SDK across services",
      "chore(deps): update transitive dependencies",
    ],
    bodyTemplate:
      "Major version bump of the payment SDK. Release notes flag breaking changes to the charge API surface.",
    labels: ["dependencies"],
    branchPrefix: "chore",
    authors: ["renovate-bot", "sam-oyelaran"],
    files: (rand) => [
      {
        filename: "package.json",
        status: "modified",
        additions: 4,
        deletions: 4,
        patch: DIFF.packageJsonBump,
      },
      {
        filename: "package-lock.json",
        status: "modified",
        additions: between(rand, 380, 920),
        deletions: between(rand, 340, 880),
        patch: DIFF.lockfileBump,
      },
      {
        filename: "src/payments/gateway.ts",
        status: "modified",
        additions: between(rand, 12, 24),
        deletions: between(rand, 8, 18),
        patch: DIFF.refactorModule,
      },
    ],
  },
  {
    key: "destructive-migration",
    titles: [
      "feat!: consolidate legacy payment columns into ledger",
      "refactor(db): drop legacy payment audit table",
      "feat!: migrate payments to the ledger model",
    ],
    bodyTemplate:
      "Moves payments onto the new ledger model.\n\n**Breaking:** drops `legacy_reference`, `gateway_blob` and the `payment_legacy_audit` table. Requires a backfill before deploy.",
    labels: ["breaking-change", "database"],
    branchPrefix: "feat",
    authors: ["marcus-lee"],
    files: (rand) => [
      {
        filename: "prisma/migrations/20260812093000_ledger_consolidation/migration.sql",
        status: "added",
        additions: 14,
        deletions: 0,
        patch: DIFF.destructiveMigration,
      },
      {
        filename: "prisma/schema.prisma",
        status: "modified",
        additions: 4,
        deletions: 2,
        patch: DIFF.schemaChange,
      },
      {
        filename: "src/payments/repository.ts",
        status: "modified",
        additions: between(rand, 40, 74),
        deletions: between(rand, 30, 60),
        patch: DIFF.refactorModule,
      },
      {
        filename: "src/payments/charge.service.ts",
        status: "modified",
        additions: between(rand, 18, 36),
        deletions: between(rand, 14, 28),
        patch: DIFF.refactorModule,
      },
      {
        filename: "src/invoices/invoice.service.ts",
        status: "modified",
        additions: between(rand, 10, 22),
        deletions: between(rand, 6, 16),
        patch: DIFF.perfFix,
      },
    ],
  },
  {
    key: "auth-change",
    titles: [
      "fix: simplify auth middleware to unblock the migration",
      "refactor(auth): streamline token verification",
      "fix: relax role checks during ledger rollout",
    ],
    bodyTemplate:
      "Temporarily relaxes role enforcement so the ledger migration can run. To be reverted once the backfill lands.",
    labels: ["security", "hotfix"],
    branchPrefix: "fix",
    authors: ["marcus-lee", "dana-whitfield"],
    files: (rand) => [
      {
        filename: "src/auth/middleware.ts",
        status: "modified",
        additions: between(rand, 8, 16),
        deletions: between(rand, 18, 30),
        patch: DIFF.authChange,
      },
      {
        filename: "src/auth/jwt.ts",
        status: "modified",
        additions: between(rand, 4, 10),
        deletions: between(rand, 6, 14),
        patch: DIFF.authChange,
      },
    ],
  },
  {
    key: "large-refactor",
    titles: [
      "refactor: replace legacy gateway abstraction across services",
      "refactor: unify payment gateway interfaces",
      "refactor: extract retry policy from gateway callers",
    ],
    bodyTemplate:
      "Mechanical but wide: replaces `LegacyGateway` with the new `PaymentGateway` interface everywhere. No behaviour change intended.",
    labels: ["refactor"],
    branchPrefix: "refactor",
    authors: ["sam-oyelaran", "marcus-lee"],
    files: (rand) => {
      const modules = [
        "payments",
        "invoices",
        "subscriptions",
        "webhooks",
        "reporting",
        "ledger",
        "refunds",
        "disputes",
      ];
      return modules.flatMap((m, i) => [
        {
          filename: `src/${m}/${m}.service.ts`,
          status: "modified" as const,
          additions: between(rand, 14, 40),
          deletions: between(rand, 12, 36),
          patch: DIFF.refactorModule,
        },
        ...(i < 4
          ? [
              {
                filename: `src/${m}/${m}.repository.ts`,
                status: "modified" as const,
                additions: between(rand, 8, 26),
                deletions: between(rand, 6, 22),
                patch: DIFF.refactorModule,
              },
            ]
          : []),
      ]);
    },
  },
  {
    key: "config-change",
    titles: [
      "chore: increase pool size and tighten request timeout",
      "chore(infra): scale api replicas for the launch",
      "chore: enable the new ledger flag in production",
    ],
    bodyTemplate:
      "Operational change ahead of the launch. Raises the DB pool and drops the request timeout to shed load faster.",
    labels: ["infrastructure"],
    branchPrefix: "chore",
    authors: ["priya-n"],
    files: () => [
      {
        filename: "docker-compose.prod.yml",
        status: "modified",
        additions: 6,
        deletions: 2,
        patch: DIFF.configChange,
      },
      {
        filename: ".github/workflows/deploy.yml",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: DIFF.infraChange,
      },
    ],
  },
  {
    key: "perf-fix",
    titles: [
      "perf: remove N+1 query from invoice listing",
      "perf: batch invoice line loading",
      "fix: eliminate per-invoice query in the customer view",
    ],
    bodyTemplate:
      "The invoice list issued one query per invoice. Replaced with a single `include`. Verified against the staging dataset.",
    labels: ["performance"],
    branchPrefix: "perf",
    authors: ["dana-whitfield"],
    files: (rand) => [
      {
        filename: "src/invoices/invoice.service.ts",
        status: "modified",
        additions: between(rand, 6, 12),
        deletions: between(rand, 8, 16),
        patch: DIFF.perfFix,
      },
      {
        filename: "tests/invoices.test.ts",
        status: "modified",
        additions: between(rand, 10, 20),
        deletions: 2,
        patch: DIFF.featureTest,
      },
    ],
  },
  {
    key: "hotfix-no-tests",
    titles: [
      "hotfix: guard against null customer on webhook replay",
      "hotfix: stop double-charging on retried webhooks",
      "hotfix: handle missing idempotency key",
    ],
    bodyTemplate:
      "Production incident INC-2291. Shipping the minimal guard now; a regression test follows in a separate PR.",
    labels: ["hotfix", "incident"],
    branchPrefix: "hotfix",
    authors: ["marcus-lee"],
    files: (rand) => [
      {
        filename: "src/webhooks/handler.ts",
        status: "modified",
        additions: between(rand, 6, 14),
        deletions: between(rand, 1, 5),
        patch: DIFF.authChange,
      },
      {
        filename: "src/payments/charge.service.ts",
        status: "modified",
        additions: between(rand, 4, 10),
        deletions: between(rand, 1, 4),
        patch: DIFF.refactorModule,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// PR generation
// ---------------------------------------------------------------------------

function archetypeFor(repo: MockRepoSpec, number: number): Archetype {
  // Deterministic but varied: rotate through archetypes per repository so every
  // repo shows a spread of risk levels.
  const offset = hashSeed(repo.name) % ARCHETYPES.length;
  return ARCHETYPES[(number + offset) % ARCHETYPES.length] as Archetype;
}

function buildFiles(repo: MockRepoSpec, number: number): FileSpec[] {
  const archetype = archetypeFor(repo, number);
  const rand = prng(hashSeed(`${repo.name}#${number}#files`));
  return archetype.files(rand, repo);
}

function sha(repo: MockRepoSpec, number: number, suffix = "head"): string {
  const seed = hashSeed(`${repo.name}#${number}#${suffix}`);
  let out = "";
  let cursor = seed;
  const rand = prng(seed);
  for (let i = 0; i < 40; i++) {
    cursor = Math.floor(rand() * 16);
    out += cursor.toString(16);
  }
  return out;
}

function buildPullSummary(repo: MockRepoSpec, number: number): GhPullRequestSummary {
  const archetype = archetypeFor(repo, number);
  const rand = prng(hashSeed(`${repo.name}#${number}#meta`));

  const author = pick(rand, archetype.authors);
  const title = pick(rand, archetype.titles);
  const ageDays = between(rand, 0, 26);
  const isClosed = ageDays > 18;
  const isMerged = isClosed && rand() > 0.35;

  return {
    id: repo.id * 1000 + number,
    number,
    title,
    body: archetype.bodyTemplate,
    state: isClosed ? "closed" : "open",
    draft: !isClosed && rand() > 0.85,
    locked: false,
    html_url: `https://github.com/${MOCK_OWNER}/${repo.name}/pull/${number}`,
    created_at: daysAgo(ageDays + between(rand, 1, 4)),
    updated_at: daysAgo(ageDays),
    closed_at: isClosed ? daysAgo(Math.max(0, ageDays - 1)) : null,
    merged_at: isMerged ? daysAgo(Math.max(0, ageDays - 1)) : null,
    merge_commit_sha: isMerged ? sha(repo, number, "merge") : null,
    user: {
      id: 900_200_000 + (hashSeed(author) % 100_000),
      login: author,
      avatar_url: `https://avatars.githubusercontent.com/u/${900_200_000 + (hashSeed(author) % 100_000)}?v=4`,
    },
    labels: archetype.labels.map((name, i) => ({
      id: 1000 + i,
      name,
      color: "ededed",
    })),
    head: {
      ref: `${archetype.branchPrefix}/${archetype.key}-${number}`,
      sha: sha(repo, number),
      repo: { full_name: `${MOCK_OWNER}/${repo.name}` },
    },
    base: { ref: "main", sha: sha(repo, number, "base") },
    comments: between(rand, 0, 9),
    review_comments: between(rand, 0, 14),
  };
}

function buildPullDetail(repo: MockRepoSpec, number: number): GhPullRequestDetail {
  const summary = buildPullSummary(repo, number);
  const files = buildFiles(repo, number);
  const rand = prng(hashSeed(`${repo.name}#${number}#detail`));

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    ...summary,
    additions,
    deletions,
    changed_files: files.length,
    commits: between(rand, 1, Math.max(2, Math.ceil(files.length / 2))),
    comments: summary.comments ?? 0,
    review_comments: summary.review_comments ?? 0,
    mergeable: summary.state === "open" ? rand() > 0.15 : null,
    mergeable_state: summary.state === "open" ? "clean" : "unknown",
    merged: summary.merged_at !== null,
    merged_by: summary.merged_at ? { login: "marcus-lee" } : null,
  };
}

function toGhFile(spec: FileSpec, repo: MockRepoSpec, number: number): GhPullRequestFile {
  const base = `https://github.com/${MOCK_OWNER}/${repo.name}`;
  const fileSha = sha(repo, number, spec.filename).slice(0, 40);
  return {
    sha: fileSha,
    filename: spec.filename,
    status: spec.status,
    additions: spec.additions,
    deletions: spec.deletions,
    changes: spec.additions + spec.deletions,
    blob_url: `${base}/blob/${sha(repo, number)}/${spec.filename}`,
    raw_url: `${base}/raw/${sha(repo, number)}/${spec.filename}`,
    contents_url: `${base}/contents/${spec.filename}`,
    ...(spec.patch ? { patch: spec.patch } : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const MOCK_USER: GhUser = {
  id: 900_000_042,
  login: "bugdna-demo",
  name: "BugDNA Demo",
  email: "demo@bugdna.dev",
  avatar_url: "https://avatars.githubusercontent.com/u/9000042?v=4",
  type: "User",
  company: "BugDNA",
  location: "Remote",
  bio: "Demo account for the BugDNA risk-intelligence platform.",
  html_url: "https://github.com/bugdna-demo",
};

function repoByName(name: string): MockRepoSpec {
  const found = MOCK_REPOS.find((r) => r.name === name);
  if (!found) {
    // Unknown repositories are synthesised so the mock never 404s a demo flow.
    return {
      id: 900_199_999,
      name,
      description: `Synthesised fixture repository for ${name}.`,
      language: "TypeScript",
      private: false,
      stars: 3,
      forks: 0,
      openIssues: 1,
      sizeKb: 5_000,
      prCount: 5,
    };
  }
  return found;
}

export const mockGitHubProvider: GitHubProvider = {
  mode: "mock",

  async exchangeOAuthCode(): Promise<GhOAuthTokenResponse> {
    return {
      access_token: "mock_gho_token_do_not_use_in_production",
      token_type: "bearer",
      scope: "read:user,user:email,repo",
    };
  },

  async getAuthenticatedUser(): Promise<GhUser> {
    return MOCK_USER;
  },

  async getAuthenticatedUserEmails(): Promise<GhEmail[]> {
    return [
      { email: "demo@bugdna.dev", primary: true, verified: true, visibility: "private" },
    ];
  },

  async listRepositories(_token, options = {}): Promise<Paged<GhRepository>> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 30;
    const all = MOCK_REPOS.map(toGhRepository);
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage);

    return {
      items,
      page,
      perPage,
      hasNextPage: start + perPage < all.length,
      rateLimit: {
        limit: 5000,
        remaining: 4987,
        used: 13,
        resetAt: new Date(Date.now() + 3_600_000),
      },
    };
  },

  async getRepository(_token, _owner, repo): Promise<GhRepository> {
    return toGhRepository(repoByName(repo));
  },

  async listPullRequests(_token, _owner, repoName, options = {}): Promise<Paged<GhPullRequestSummary>> {
    const repo = repoByName(repoName);
    const state = options.state ?? "open";
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 30;

    const all = Array.from({ length: repo.prCount }, (_, i) =>
      buildPullSummary(repo, repo.prCount - i),
    ).filter((pr) => (state === "all" ? true : pr.state === state));

    const start = (page - 1) * perPage;

    return {
      items: all.slice(start, start + perPage),
      page,
      perPage,
      hasNextPage: start + perPage < all.length,
    };
  },

  async getPullRequest(_token, _owner, repoName, number): Promise<GhPullRequestDetail> {
    return buildPullDetail(repoByName(repoName), number);
  },

  async listPullRequestFiles(_token, _owner, repoName, number) {
    const repo = repoByName(repoName);
    const files = buildFiles(repo, number).map((f) => toGhFile(f, repo, number));
    return { files, truncated: false };
  },

  async listDeployments(_token, _owner, repoName, options = {}): Promise<GhDeployment[]> {
    const repo = repoByName(repoName);
    const rand = prng(hashSeed(`${repo.name}#deployments`));
    const count = options.perPage ?? 12;

    return Array.from({ length: count }, (_, i) => ({
      id: repo.id * 100 + i,
      sha: sha(repo, i + 1, "deploy"),
      ref: "main",
      task: "deploy",
      environment: options.environment ?? (rand() > 0.3 ? "production" : "staging"),
      description: "Automated deploy from main",
      created_at: daysAgo(i * 2 + 1),
      updated_at: daysAgo(i * 2 + 1),
      creator: { login: "github-actions[bot]" },
    }));
  },

  async validateToken() {
    return { valid: true, scopes: ["read:user", "user:email", "repo"] };
  },
};

/** Exposed so the seed script can build the same fixtures without HTTP. */
export const mockFixtures = {
  owner: MOCK_OWNER,
  repos: MOCK_REPOS,
  user: MOCK_USER,
  toGhRepository,
  buildPullSummary,
  buildPullDetail,
  buildFiles,
  toGhFile,
  archetypeFor,
  daysAgo,
  sha,
};
