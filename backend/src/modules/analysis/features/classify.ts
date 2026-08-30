/**
 * File and patch classification.
 *
 * This is the bottom of the feature-extraction stack: given a path and its
 * unified diff, decide what *kind* of change it is. Everything above — the
 * feature vector, the risk factors, the recommendations — is built from these
 * booleans, so they are deliberately simple, explainable and testable.
 *
 * Two properties matter more than sophistication here:
 *
 *  - **Deterministic.** The same file always classifies the same way, so a
 *    re-analysis of an unchanged commit produces an identical feature vector.
 *  - **Legible.** A developer shown "this was counted as a migration" must be
 *    able to see why. That rules out anything statistical at this layer.
 *
 * Patterns live in config/constants.ts as data, so supporting a new ecosystem
 * means adding a regex, not editing logic.
 */
import {
  EXTENSION_LANGUAGE,
  PATCH_PATTERNS,
  PATH_PATTERNS,
  SOURCE_EXTENSIONS,
} from "../../../config/constants";

export interface FileClassification {
  extension: string | null;
  language: string | null;
  /** Top-level-ish module the path belongs to, used for blast-radius counting. */
  module: string | null;
  isTest: boolean;
  isConfig: boolean;
  isDependencyManifest: boolean;
  isMigration: boolean;
  isInfra: boolean;
  isDocs: boolean;
  isGenerated: boolean;
  isSource: boolean;
  touchesPublicApi: boolean;
  /** Patch-level signals, used by the feature extractor and recommendations. */
  hasDestructiveSql: boolean;
  touchesAuthOrSecrets: boolean;
  removesErrorHandling: boolean;
  addsTodoMarkers: boolean;
}

const anyMatch = (patterns: readonly RegExp[], value: string): boolean =>
  patterns.some((p) => p.test(value));

export function extensionOf(filename: string): string | null {
  const base = filename.split("/").pop() ?? filename;
  // Dotfiles like `.env` have no extension in the useful sense.
  if (base.startsWith(".") && !base.slice(1).includes(".")) return null;
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return null;
  return base.slice(idx + 1).toLowerCase();
}

/**
 * Derive the module a path belongs to.
 *
 * Heuristic, and honest about it: skip conventional container directories
 * (`src`, `lib`, `app`, `packages/<name>`) so `src/auth/jwt.ts` reports `auth`
 * rather than `src`. Without this every file in a conventional layout would
 * collapse into one "module" and blast radius would always be 1.
 */
export function moduleOf(filename: string): string | null {
  const parts = filename.split("/").filter(Boolean);
  if (parts.length <= 1) return null; // a root-level file has no module

  const skip = new Set([
    "src", "lib", "app", "source", "sources", "internal", "pkg", "cmd", "modules",
  ]);

  let index = 0;

  // `packages/foo/...` or `apps/foo/...` -> the workspace name is the module.
  if ((parts[0] === "packages" || parts[0] === "apps" || parts[0] === "services") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  while (index < parts.length - 1 && skip.has((parts[index] ?? "").toLowerCase())) {
    index++;
  }

  const candidate = parts[index];
  if (!candidate || index === parts.length - 1) {
    // Everything was a container directory; fall back to the first segment.
    return parts[0] ?? null;
  }

  return candidate;
}

export function classifyFile(filename: string, patch?: string | null): FileClassification {
  const path = filename.replace(/\\/g, "/");
  const extension = extensionOf(path);
  const body = patch ?? "";

  const isGenerated = anyMatch(PATH_PATTERNS.generated, path);
  const isDocs = anyMatch(PATH_PATTERNS.docs, path);
  const isTest = anyMatch(PATH_PATTERNS.test, path);
  const isDependencyManifest = anyMatch(PATH_PATTERNS.dependencyManifest, path);
  const isMigration = anyMatch(PATH_PATTERNS.migration, path);
  const isInfra = anyMatch(PATH_PATTERNS.infra, path);

  // Order matters: a dependency manifest is also YAML/JSON, but calling it
  // "config" would double-count it. The more specific classification wins.
  const isConfig =
    !isDependencyManifest && !isMigration && !isInfra && anyMatch(PATH_PATTERNS.config, path);

  const isSource =
    extension !== null &&
    SOURCE_EXTENSIONS.has(extension) &&
    !isTest &&
    !isGenerated &&
    !isDocs;

  return {
    extension,
    language: extension ? (EXTENSION_LANGUAGE[extension] ?? null) : null,
    module: moduleOf(path),
    isTest,
    isConfig,
    isDependencyManifest,
    isMigration,
    isInfra,
    isDocs,
    isGenerated,
    isSource,
    // Public-API detection is only meaningful for source changes; a docs file
    // containing the word `export` is not an API change.
    touchesPublicApi: isSource && anyMatch(PATCH_PATTERNS.publicApi, body),
    hasDestructiveSql:
      (isMigration || extension === "sql" || extension === "prisma") &&
      anyMatch(PATCH_PATTERNS.destructiveSql, body),
    touchesAuthOrSecrets:
      !isDocs && !isTest && anyMatch(PATCH_PATTERNS.authSensitive, path + "\n" + body),
    removesErrorHandling: isSource && anyMatch(PATCH_PATTERNS.errorHandlingRemoved, body),
    addsTodoMarkers: anyMatch(PATCH_PATTERNS.todoMarkers, body),
  };
}

/** Map GitHub's file status onto the Prisma enum. */
export function toFileChangeType(
  status: string,
):
  | "ADDED"
  | "MODIFIED"
  | "REMOVED"
  | "RENAMED"
  | "COPIED"
  | "CHANGED"
  | "UNCHANGED" {
  switch (status) {
    case "added":
      return "ADDED";
    case "removed":
      return "REMOVED";
    case "renamed":
      return "RENAMED";
    case "copied":
      return "COPIED";
    case "changed":
      return "CHANGED";
    case "unchanged":
      return "UNCHANGED";
    case "modified":
    default:
      return "MODIFIED";
  }
}

/**
 * Truncate a patch to a byte budget on a line boundary.
 *
 * Diffs are stored for reviewer context, not archival, and a single generated
 * file can be megabytes. Cutting mid-line would produce a corrupt-looking hunk
 * in the UI, so the cut lands between lines and is flagged.
 */
export function truncatePatch(
  patch: string | undefined,
  maxBytes: number,
): { patch: string | null; truncated: boolean } {
  if (!patch) return { patch: null, truncated: false };
  if (Buffer.byteLength(patch, "utf8") <= maxBytes) return { patch, truncated: false };

  const lines = patch.split("\n");
  const kept: string[] = [];
  let size = 0;

  for (const line of lines) {
    const lineSize = Buffer.byteLength(line, "utf8") + 1;
    if (size + lineSize > maxBytes) break;
    kept.push(line);
    size += lineSize;
  }

  return {
    patch: kept.join("\n") + "\n… diff truncated by BugDNA …",
    truncated: true,
  };
}
