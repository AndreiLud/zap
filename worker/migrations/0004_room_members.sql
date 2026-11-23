-- Which rooms each device sits in, so deleting a person (or moving them to another browser with
-- a recovery code) reaches every room that still holds their device id. A row is written when the
-- device joins a room or a match starts there, and lasts 24 hours after that, like the room.
CREATE TABLE IF NOT EXISTS room_members (
  code TEXT NOT NULL,
  device TEXT NOT NULL,                      -- devices.id
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (code, device)
);
CREATE INDEX IF NOT EXISTS room_members_device ON room_members (device);
CREATE INDEX IF NOT EXISTS room_members_expires ON room_members (expires_at);
