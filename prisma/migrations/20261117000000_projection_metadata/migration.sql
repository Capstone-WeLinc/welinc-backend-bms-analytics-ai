-- Existing local workers may already have created this exact table.
CREATE TABLE IF NOT EXISTS bms_projection_rows (
 booking_uuid UUID PRIMARY KEY,
 projected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
