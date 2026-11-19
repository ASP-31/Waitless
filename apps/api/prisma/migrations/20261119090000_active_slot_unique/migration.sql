-- Rebooking a cancelled slot must be possible. The original all-rows unique
-- constraint on (doctorId, slotStart) blocked that, so replace it with a
-- partial unique index covering only rows that still hold the slot.
DROP INDEX IF EXISTS "Appointment_doctorId_slotStart_key";

CREATE UNIQUE INDEX "Appointment_active_slot_unique"
  ON "Appointment" ("doctorId", "slotStart")
  WHERE "status" NOT IN ('CANCELLED', 'NO_SHOW', 'SKIPPED', 'COMPLETED');

-- Scheduler audit trail for the grace-period transition.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'QUEUE_DELAYED';
