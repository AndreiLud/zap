-- Every room is listed (quick play too), so the Worker can refuse unknown codes without waking
-- a Durable Object; only rooms with friends count toward the limit of 3 per device.
ALTER TABLE open_rooms ADD COLUMN mode TEXT NOT NULL DEFAULT 'room';
