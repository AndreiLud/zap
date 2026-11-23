-- Public counters for the data page (GET /api/live, worker/src/public-data.ts). One row; no person
-- in it. Each finished match adds itself and the moves its people made in the same D1 batch as its
-- match row, only while D1 has no row for that match (worker/src/privacy.ts matchRowStatements),
-- so a batch tried again never counts twice.
CREATE TABLE IF NOT EXISTS live_counts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  matches INTEGER NOT NULL DEFAULT 0,     -- finished matches with at least one person
  decisions INTEGER NOT NULL DEFAULT 0,   -- moves people made themselves
  updated_at INTEGER NOT NULL DEFAULT 0
);
-- Matches already in D1 are counted; their moves are not in D1, so decisions starts at 0.
INSERT OR IGNORE INTO live_counts (id, matches, decisions, updated_at) SELECT 1, count(*), 0, 0 FROM matches;
