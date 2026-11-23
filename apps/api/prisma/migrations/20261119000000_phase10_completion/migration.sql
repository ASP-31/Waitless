-- Queue self check-in, sensor-suggested consultation end, push subscriptions
-- and room health tracking (Phases 6, 7, 9 and 10).

ALTER TABLE "QueueEntry" ADD COLUMN "selfCheckInAt" TIMESTAMP(3);
ALTER TABLE "Consultation" ADD COLUMN "suggestedEndAt" TIMESTAMP(3);
ALTER TABLE "NotificationPreference" ADD COLUMN "pushSubscriptions" JSONB;
ALTER TABLE "Room" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ONLINE';
ALTER TABLE "Room" ADD COLUMN "lastEventAt" TIMESTAMP(3);
