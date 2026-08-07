-- Adds the column the Twilio migration's CallRelay Durable Object (Phase 2+)
-- needs to look up a live call by its Twilio CallSid.
--
-- This is an ADD, not the rename the migration plan originally described
-- (docs/technical-decisions.md, ADR-006) — deliberately. Vapi's live code
-- (routes/webhook.ts, lib/store.ts) actively reads and writes `control_url`
-- on every real call today, and Phase 1's own pacing rule is "deployable;
-- changes nothing observable." Renaming that column out from under Vapi's
-- working code would violate that rule for no benefit this early — Vapi
-- stays the only backend actually serving calls through the end of Phase 2.
-- `control_url` gets retired for real in Phase 7, alongside the rest of the
-- Vapi code path, once the Twilio path has passed its own live compliance
-- test end to end. Until then the two columns simply coexist, one written by
-- each backend, same as `Config.vapi` and `Config.twilio` coexist in
-- lib/config.ts over the same stretch.
--
-- Run with: wrangler d1 execute conversation-delegation --remote --file=./migrations/0001_add_twilio_call_sid.sql

ALTER TABLE calls ADD COLUMN twilio_call_sid TEXT;

-- The Twilio call-status callback (routes/twilio.ts, Phase 2) looks up a
-- call by CallSid, not by our own call_id — this index is for that lookup.
CREATE INDEX IF NOT EXISTS idx_calls_twilio_call_sid ON calls (twilio_call_sid);
