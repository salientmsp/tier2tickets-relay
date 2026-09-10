-- Egress Jira fan-out for co-managed clients (created tickets → Jira). As with 0001,
-- the Worker self-creates + additively migrates these at runtime (src/core/db.ts
-- initSchema), so applying this is optional but recommended for a fresh DB. On an
-- EXISTING DB the CREATE ... IF NOT EXISTS below are no-ops and the runtime handles the
-- additive `jira_issue_key` column add (an ALTER here would fail if the column already
-- exists), so this migration deliberately does NOT ALTER created_tickets.

-- Ledger of tickets we created in Gorelo (keyed by the Halo id handed back). Included
-- here in its full current shape — it was introduced after 0001 with no migration of
-- its own — so a fresh DB gets it (with the Jira link column) from migrations alone.
-- Mirrors the CREATE in src/core/db.ts initSchema exactly.
CREATE TABLE IF NOT EXISTS created_tickets (
  halo_id        INTEGER PRIMARY KEY,
  gorelo_id      TEXT,
  number         INTEGER,
  display_number TEXT,
  title          TEXT,
  client_id      INTEGER,
  contact_id     INTEGER,
  status_id      INTEGER,
  created_at     TEXT NOT NULL,
  jira_issue_key TEXT
);

-- Durable retry queue for the egress Jira fan-out. A create/close that fails in the
-- request's waitUntil is enqueued here and drained by the */5 cron alongside
-- pending_tickets. Only non-secret routing data is stored (client_id + the issue
-- payload); credentials live in the JIRA_TARGETS secret and are resolved by client_id
-- at flush time. Mirrors the CREATE in src/core/db.ts initSchema exactly.
CREATE TABLE IF NOT EXISTS pending_jira (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,       -- "create" | "close"
  client_id  INTEGER NOT NULL,
  halo_id    INTEGER,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_jira_created ON pending_jira (created_at);
