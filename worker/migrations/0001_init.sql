-- Devices: the only link between a person (by the hash of their device secret) and the game.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,                       -- SHA-256 of the device cookie secret
  created_at INTEGER NOT NULL,
  verified_at INTEGER,                       -- last time the human check (Turnstile) passed
  matches_since_verify INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,        -- suspected automation, out of ranking and training
  blocked_until INTEGER NOT NULL DEFAULT 0   -- temporary block after flooding
);

-- Rooms created by each device, to cap open rooms at 3 per device.
CREATE TABLE IF NOT EXISTS open_rooms (
  code TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS open_rooms_device ON open_rooms (device, expires_at);
