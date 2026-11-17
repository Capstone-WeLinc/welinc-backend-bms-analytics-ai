-- The populated projection writes these fields; keep every column migration-owned.
ALTER TABLE bookings
  ADD COLUMN booking_no VARCHAR(50),
  ADD COLUMN arrival_time TEXT,
  ADD COLUMN additional_materials TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE scheduled_bookings
  ADD COLUMN dispatch_time TEXT,
  ADD COLUMN created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now();
