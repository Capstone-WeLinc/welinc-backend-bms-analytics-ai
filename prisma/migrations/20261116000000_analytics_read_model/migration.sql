-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "booking_id" VARCHAR(50) NOT NULL,
    "client" VARCHAR(200) NOT NULL,
    "service" VARCHAR(100) NOT NULL,
    "date" TEXT NOT NULL,
    "pickup_address" TEXT,
    "delivery_address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'For Plotting',
    "amount" DECIMAL(10,2),
    "discrepancy_note" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "time" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "service_type" VARCHAR(120),
    "delivery_category" VARCHAR(40),
    "address" TEXT,
    "total_amount" TEXT,
    "payment_status" TEXT DEFAULT 'Pending',
    "payment_method" TEXT,
    "full_name" VARCHAR(200),
    "contact" TEXT,
    "email" TEXT,
    "delivery_location" TEXT,
    "estimated_items" INTEGER,
    "item_details" TEXT,
    "special_instructions" TEXT,
    "notes" TEXT,
    "services_availed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "protective_materials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "additional_services_availed" JSONB,
    "has_insurance" BOOLEAN NOT NULL DEFAULT false,
    "permit_required" BOOLEAN NOT NULL DEFAULT false,
    "post_service_status" VARCHAR(40) DEFAULT 'Pending Review',
    "arrival_status" VARCHAR(40),
    "delay_minutes" INTEGER,
    "overtime_hours" DECIMAL(4,2),
    "overtime_charge" DECIMAL(10,2),
    "amount_paid" DECIMAL(10,2),
    "completion_notes" TEXT,
    "issue_reported" BOOLEAN DEFAULT false,
    "issue_details" TEXT,
    "finalized_at" TIMESTAMPTZ(6),
    "finalized_by" VARCHAR(100),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_bookings" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "garage" VARCHAR(120),
    "delivery_type" VARCHAR(20),
    "vehicle_id" UUID,
    "driver_id" UUID,
    "helper_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "scheduled_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_booking_id_key" ON "bookings"("booking_id");

-- CreateIndex
CREATE INDEX "bookings_deleted_at_idx" ON "bookings"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_bookings_booking_id_key" ON "scheduled_bookings"("booking_id");

-- AddForeignKey
ALTER TABLE "scheduled_bookings" ADD CONSTRAINT "scheduled_bookings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
