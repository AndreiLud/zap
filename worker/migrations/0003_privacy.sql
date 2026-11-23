-- Data and privacy (M5). Identity in three pieces: the device id (hash of the cookie secret), a
-- random pseudonym that exists only in this database, and, in the game data, only a match id and
-- seat numbers. match_seats is the one place that links a pseudonym to a seat. No IP anywhere.

ALTER TABLE devices ADD COLUMN pseudonym TEXT;                                -- 128 random bits (hex), set at the first check
ALTER TABLE devices ADD COLUMN adult_at INTEGER;                              -- when the person declared being 18 or older
ALTER TABLE devices ADD COLUMN last_seen INTEGER;                             -- last check or match start (retention: 12 months)
ALTER TABLE devices ADD COLUMN nickname TEXT;                                 -- filtered; null shows "Jogador N"
ALTER TABLE devices ADD COLUMN nickname_hidden INTEGER NOT NULL DEFAULT 0;    -- reported, hidden until reviewed
ALTER TABLE devices ADD COLUMN open_data_opt_out INTEGER NOT NULL DEFAULT 0;  -- "fora dos dados abertos"
ALTER TABLE devices ADD COLUMN no_adapt INTEGER NOT NULL DEFAULT 0;           -- "não adaptar a mim"
ALTER TABLE devices ADD COLUMN abandons INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN recovery_hash TEXT;                            -- SHA-256 of the recovery code; the code is never kept

UPDATE devices SET last_seen = COALESCE(verified_at, created_at) WHERE last_seen IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS devices_pseudonym ON devices (pseudonym);
CREATE UNIQUE INDEX IF NOT EXISTS devices_recovery ON devices (recovery_hash);
CREATE INDEX IF NOT EXISTS devices_last_seen ON devices (last_seen);

-- Finished matches. The record itself (no person in it) is in R2 at record_key.
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,                       -- random UUID, unrelated to the room code
  started_at INTEGER,
  ended_at INTEGER,
  kind TEXT,                                 -- solo2, solo1, friends, humans, mixed
  variant TEXT,
  players INTEGER,
  ai_version TEXT,
  record_key TEXT
);
CREATE INDEX IF NOT EXISTS matches_ended ON matches (ended_at);

-- Who sat where: the only link between a person (pseudonym) and the game data.
CREATE TABLE IF NOT EXISTS match_seats (
  match_id TEXT,
  seat INTEGER,
  pseudonym TEXT,
  verified INTEGER,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX IF NOT EXISTS match_seats_pseudonym ON match_seats (pseudonym);

-- Reports from the table menu. reporter and target are pseudonyms; target is null for an AI seat
-- and after the reported person deletes their data.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER,
  match_id TEXT,
  room_code TEXT,
  seat INTEGER,
  reason TEXT,                               -- nickname, phrases, cheating, other
  reporter TEXT,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter);
CREATE INDEX IF NOT EXISTS reports_target ON reports (target);
CREATE INDEX IF NOT EXISTS reports_created ON reports (created_at);

-- Moderation marks (suspected automation, abuse), kept 12 months after review.
CREATE TABLE IF NOT EXISTS flags (
  pseudonym TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER,
  reviewed_at INTEGER,
  decision TEXT
);
