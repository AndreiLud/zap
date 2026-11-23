-- The brake (worker/src/brake.ts): one row per UTC day with what the matches reserved before they
-- started and what they really spent, so a match that would take a limit past its share does not
-- start. No person in it. r_* are reservations still open, s_* real spend after the swap.
CREATE TABLE IF NOT EXISTS brake_days (
  day TEXT PRIMARY KEY,                       -- YYYY-MM-DD (UTC); t-<16 hex> only on local test sites
  matches INTEGER NOT NULL DEFAULT 0,         -- matches admitted
  settled INTEGER NOT NULL DEFAULT 0,         -- of those, swapped for their real spend
  refused INTEGER NOT NULL DEFAULT 0,         -- starts the brake refused
  ticket TEXT,                                -- the last admission, which ties the allowance to it in one batch
  r_wreq INTEGER NOT NULL DEFAULT 0, s_wreq INTEGER NOT NULL DEFAULT 0,       -- Worker requests
  r_doreq INTEGER NOT NULL DEFAULT 0, s_doreq INTEGER NOT NULL DEFAULT 0,     -- Durable Object requests (not WebSocket messages)
  r_dows INTEGER NOT NULL DEFAULT 0, s_dows INTEGER NOT NULL DEFAULT 0,       -- incoming WebSocket messages
  r_dorows INTEGER NOT NULL DEFAULT 0, s_dorows INTEGER NOT NULL DEFAULT 0,   -- Durable Object rows written
  r_doms INTEGER NOT NULL DEFAULT 0, s_doms INTEGER NOT NULL DEFAULT 0,       -- room time awake in ms (8,000 ms = 1 GB-s)
  r_d1w INTEGER NOT NULL DEFAULT 0, s_d1w INTEGER NOT NULL DEFAULT 0,         -- D1 rows written
  r_d1r INTEGER NOT NULL DEFAULT 0, s_d1r INTEGER NOT NULL DEFAULT 0,         -- D1 rows read
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
