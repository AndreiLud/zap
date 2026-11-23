-- Style counters per person and rules segment (milestone 6). Deleted with the device; see retention.md.
CREATE TABLE IF NOT EXISTS profiles (
  pseudonym TEXT NOT NULL,
  segment TEXT NOT NULL,                      -- paulista-2, paulista-4, mineiro-2, mineiro-4
  matches INTEGER NOT NULL DEFAULT 0,
  decisions INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0, k INTEGER NOT NULL DEFAULT 0, u INTEGER NOT NULL DEFAULT 0,
  a INTEGER NOT NULL DEFAULT 0, x INTEGER NOT NULL DEFAULT 0, s REAL NOT NULL DEFAULT 0,
  q INTEGER NOT NULL DEFAULT 0, v INTEGER NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 0,
  bc INTEGER NOT NULL DEFAULT 0, br INTEGER NOT NULL DEFAULT 0, g INTEGER NOT NULL DEFAULT 0, gt INTEGER NOT NULL DEFAULT 0,
  tn INTEGER NOT NULL DEFAULT 0, tl REAL NOT NULL DEFAULT 0, tl2 REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pseudonym, segment)
);
-- Random group token per person per daily export: the only way a flag from the cycle finds its person. 30 days.
CREATE TABLE IF NOT EXISTS export_groups (
  export_date TEXT NOT NULL,
  grp TEXT NOT NULL,                          -- 16 hex characters
  pseudonym TEXT NOT NULL,
  PRIMARY KEY (export_date, grp),
  UNIQUE (export_date, pseudonym)
);
CREATE INDEX IF NOT EXISTS export_groups_pseudonym ON export_groups (pseudonym);
-- Files imported from the cycle (control/priors.json, control/flags.json). No person in them.
CREATE TABLE IF NOT EXISTS cycle_imports (
  name TEXT PRIMARY KEY,                      -- priors, flags
  sha256 TEXT NOT NULL,
  body TEXT,                                  -- the validated priors JSON; NULL for flags
  imported_at INTEGER NOT NULL
);
ALTER TABLE flags ADD COLUMN ref TEXT;        -- "<export date>:<group>" of the cycle's flag
CREATE UNIQUE INDEX IF NOT EXISTS flags_ref ON flags (ref);
