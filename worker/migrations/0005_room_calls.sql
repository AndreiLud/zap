-- Calls the Worker could not get through to a room when a person deleted their data (forget) or
-- moved it to another browser (rekey): the room was restarting, overloaded, or still running the
-- code from before a deploy. The daily retention job tries them again; a row goes when the room
-- answers or is gone.
CREATE TABLE IF NOT EXISTS room_calls (
  code TEXT NOT NULL,                        -- the room
  device TEXT NOT NULL,                      -- the id the room must let go of
  to_device TEXT,                            -- recovery: the new id; NULL after a deletion
  created_at INTEGER NOT NULL,
  PRIMARY KEY (code, device)
);
CREATE INDEX IF NOT EXISTS room_calls_to ON room_calls (to_device);

-- Since this release, room_members rows last as long as their room: the room carries every seated
-- person's row along with its listing (Room.refreshListing), so the 24 hour rule in 0004's comment
-- no longer applies. No data change is needed: older rows only ever get longer.
