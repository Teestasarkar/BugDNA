/**
 * File classification tests.
 *
 * This is the bottom of the risk stack: every feature, factor and recommendation
 * is built on these booleans. A misclassification here does not throw — it
 * quietly changes a score. So the cases below are the ones that would actually
 * be wrong in a real repository, not a restatement of the regexes.
 */
import { describe, expect, it } from "vitest";
import {
  classifyFile,
  extensionOf,
  moduleOf,
  toFileChangeType,
  truncatePatch,
} from "../src/modules/analysis/features/classify";

describe("extensionOf", () => {
  it("reads ordinary extensions", () => {
    expect(extensionOf("src/index.ts")).toBe("ts");
    expect(extensionOf("a/b/c/Component.tsx")).toBe("tsx");
    expect(extensionOf("script.PY")).toBe("py"); // normalised
  });

  it("treats a dotfile as having no extension", () => {
    // `.env` is a config file, not a file of type "env".
    expect(extensionOf(".env")).toBeNull();
    expect(extensionOf(".gitignore")).toBeNull();
  });

  it("reads the extension of a dotfile that has one", () => {
    expect(extensionOf(".eslintrc.json")).toBe("json");
  });

  it("returns null when there is nothing after the dot", () => {
    expect(extensionOf("Makefile")).toBeNull();
    expect(extensionOf("weird.")).toBeNull();
  });
});

describe("moduleOf", () => {
  it("skips conventional container directories", () => {
    // Without this, every file in a conventional layout collapses into one
    // "module" and blast radius is always 1.
    expect(moduleOf("src/auth/jwt.ts")).toBe("auth");
    expect(moduleOf("lib/payments/charge.ts")).toBe("payments");
    expect(moduleOf("app/checkout/page.tsx")).toBe("checkout");
  });

  it("keeps the workspace name for monorepo layouts", () => {
    expect(moduleOf("packages/ui/button.tsx")).toBe("packages/ui");
    expect(moduleOf("apps/web/page.tsx")).toBe("apps/web");
    expect(moduleOf("services/billing/main.go")).toBe("services/billing");
  });

  it("returns null for a root-level file", () => {
    expect(moduleOf("README.md")).toBeNull();
    expect(moduleOf("package.json")).toBeNull();
  });

  it("falls back to the first segment when everything is a container", () => {
    expect(moduleOf("src/index.ts")).toBe("src");
  });
});

describe("classifyFile", () => {
  it("recognises tests across ecosystems", () => {
    for (const path of [
      "tests/auth.test.ts",
      "src/__tests__/charge.spec.tsx",
      "app/models_test.go",
      "test_payments.py",
      "src/UserServiceTest.java",
      "features/checkout.feature",
    ]) {
      expect(classifyFile(path).isTest, `${path} should classify as a test`).toBe(true);
    }
  });

  it("recognises dependency manifests across ecosystems", () => {
    for (const path of [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "requirements.txt",
      "poetry.lock",
      "go.mod",
      "Cargo.toml",
      "Gemfile.lock",
      "pom.xml",
      "composer.json",
    ]) {
      expect(
        classifyFile(path).isDependencyManifest,
        `${path} should classify as a dependency manifest`,
      ).toBe(true);
    }
  });

  it("recognises migrations", () => {
    for (const path of [
      "prisma/migrations/20260812_x/migration.sql",
      "db/migrate/001_create_users.rb",
      "alembic/versions/abc.py",
      "prisma/schema.prisma",
    ]) {
      expect(classifyFile(path).isMigration, `${path} should be a migration`).toBe(true);
    }
  });

  it("prefers the more specific classification over config", () => {
    // A lockfile is also YAML, and a migration directory may contain YAML.
    // Counting them as "config" as well would double-count the same change.
    const lockfile = classifyFile("pnpm-lock.yaml");
    expect(lockfile.isDependencyManifest).toBe(true);
    expect(lockfile.isConfig).toBe(false);

    const migration = classifyFile("prisma/migrations/20260812_x/migration.sql");
    expect(migration.isMigration).toBe(true);
    expect(migration.isConfig).toBe(false);
  });

  it("does not treat a test file as source", () => {
    // Otherwise test churn inflates source churn and the ratio is meaningless.
    const classification = classifyFile("src/auth/jwt.test.ts");
    expect(classification.isTest).toBe(true);
    expect(classification.isSource).toBe(false);
  });

  it("detects destructive SQL only in schema-bearing files", () => {
    const destructive = classifyFile(
      "prisma/migrations/20260812_x/migration.sql",
      '+ALTER TABLE "payments" DROP COLUMN "legacy_reference";',
    );
    expect(destructive.hasDestructiveSql).toBe(true);

    // The word DROP in application code is not a schema change.
    const prose = classifyFile("src/docs/notes.ts", "+// we should DROP TABLE eventually");
    expect(prose.hasDestructiveSql).toBe(false);
  });

  it("detects a new NOT NULL without a default as destructive", () => {
    // It fails outright on a populated table, taking the deploy with it.
    const classification = classifyFile(
      "migrations/002.sql",
      '+ALTER TABLE "invoices" ALTER COLUMN "currency" SET NOT NULL;',
    );
    expect(classification.hasDestructiveSql).toBe(true);
  });

  it("does not flag NOT NULL when a default is supplied", () => {
    const classification = classifyFile(
      "migrations/003.sql",
      "+ALTER TABLE \"invoices\" ADD COLUMN \"currency\" TEXT NOT NULL DEFAULT 'GBP';",
    );
    expect(classification.hasDestructiveSql).toBe(false);
  });

  it("detects public API changes only in source files", () => {
    const exported = classifyFile(
      "src/api/routes.ts",
      "+export async function upgradeSubscription(id: string) {",
    );
    expect(exported.touchesPublicApi).toBe(true);

    // A docs file containing the word "export" is not an API change.
    const docs = classifyFile("docs/api.md", "+export const foo = 1");
    expect(docs.touchesPublicApi).toBe(false);
  });

  it("detects removed error handling", () => {
    const classification = classifyFile(
      "src/auth/middleware.ts",
      "-  try {\n-    const claims = await verifyToken(token);\n+  const claims = await verifyToken(token);",
    );
    expect(classification.removesErrorHandling).toBe(true);
  });

  it("does not treat added error handling as removal", () => {
    const classification = classifyFile(
      "src/auth/middleware.ts",
      "+  try {\n+    const claims = await verifyToken(token);",
    );
    expect(classification.removesErrorHandling).toBe(false);
  });

  it("detects auth-sensitive changes but not in tests or docs", () => {
    expect(
      classifyFile("src/auth/session.ts", "+const token = signJwt(payload);")
        .touchesAuthOrSecrets,
    ).toBe(true);

    // A test asserting on a password is not a change to auth behaviour.
    expect(
      classifyFile("tests/auth.test.ts", "+expect(password).toBe('hunter2')")
        .touchesAuthOrSecrets,
    ).toBe(false);
  });

  it("maps extensions to display languages", () => {
    expect(classifyFile("src/a.ts").language).toBe("TypeScript");
    expect(classifyFile("src/a.py").language).toBe("Python");
    expect(classifyFile("src/a.unknownext").language).toBeNull();
  });
});

describe("toFileChangeType", () => {
  it("maps every GitHub status", () => {
    expect(toFileChangeType("added")).toBe("ADDED");
    expect(toFileChangeType("removed")).toBe("REMOVED");
    expect(toFileChangeType("renamed")).toBe("RENAMED");
    expect(toFileChangeType("copied")).toBe("COPIED");
    expect(toFileChangeType("changed")).toBe("CHANGED");
    expect(toFileChangeType("unchanged")).toBe("UNCHANGED");
    expect(toFileChangeType("modified")).toBe("MODIFIED");
  });

  it("defaults an unknown status to MODIFIED rather than throwing", () => {
    expect(toFileChangeType("something-new")).toBe("MODIFIED");
  });
});

describe("truncatePatch", () => {
  it("leaves a small patch untouched", () => {
    const result = truncatePatch("@@ -1 +1 @@\n-a\n+b", 1000);
    expect(result.truncated).toBe(false);
    expect(result.patch).toBe("@@ -1 +1 @@\n-a\n+b");
  });

  it("cuts on a line boundary, never mid-line", () => {
    // A cut mid-line renders as a corrupt hunk in the diff view.
    const patch = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const result = truncatePatch(patch, 200);

    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("diff truncated by BugDNA");

    const body = (result.patch ?? "").split("\n").filter((l) => l.startsWith("+line"));
    for (const line of body) {
      expect(line).toMatch(/^\+line \d+$/); // no partial lines
    }
  });

  it("handles a null patch", () => {
    const result = truncatePatch(undefined, 100);
    expect(result.patch).toBeNull();
    expect(result.truncated).toBe(false);
  });
});
