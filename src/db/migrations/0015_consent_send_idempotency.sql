-- Add a one-shot create key for /admin/clients/new so browser retries
-- cannot create duplicate retreats or duplicate consent-package sends.
-- Also stop the client-facing consent-package event from targeting
-- support@ as a notification recipient. The Gmail sender is support@,
-- so a support@ -> support@ self-send creates noisy mailbox copies.

ALTER TABLE "retreats"
ADD COLUMN IF NOT EXISTS "create_request_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retreats_create_request_id_idx"
ON "retreats" USING btree ("create_request_id")
WHERE "create_request_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "notification_recipients"
SET "active" = false
WHERE "event_type" = 'consent_package_sent'
  AND "email" = 'support@intensivetherapyretreat.com';
