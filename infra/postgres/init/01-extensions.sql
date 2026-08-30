-- =============================================================================
-- BugDNA — database initialisation
-- =============================================================================
-- Runs once, on an empty data directory. Schema itself is owned by Prisma
-- migrations; this file is only for things a migration cannot do, which in
-- practice means extensions.

-- pg_trgm: trigram indexes for the substring search in modules/search. Without
-- it, `contains` searches on pull request titles are sequential scans once the
-- table is large. The extension is created here rather than in a migration
-- because CREATE EXTENSION requires superuser, which the app role does not have
-- in production.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- citext: case-insensitive text, used if email uniqueness ever needs it.
CREATE EXTENSION IF NOT EXISTS citext;

-- Log slow queries so a regression is visible without extra tooling.
ALTER SYSTEM SET log_min_duration_statement = '500ms';
