-- D1 schema for the delegation backend.
--
-- Note what is NOT stored: recipient phone numbers. We never learn them — the
-- user dials, not us — and keeping it that way is the cleanest possible answer
-- to "what do you hold about the person who was called."

CREATE TABLE IF NOT EXISTS calls (
  call_id              TEXT PRIMARY KEY,
  phase                TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,

  -- Vapi live-call control URL, from monitor.controlUrl.
  control_url          TEXT,

  -- Intent object as JSON, once extracted at handoff.
  intent               TEXT,

  -- Compliance state. disclosure_delivered is written with a conditional
  -- UPDATE so two concurrent webhook events can't both fire the backstop.
  disclosure_delivered INTEGER NOT NULL DEFAULT 0,
  armed_at             TEXT,
  user_first_name      TEXT,
  backstop_fired       INTEGER NOT NULL DEFAULT 0,
  handoff_trigger      TEXT,
  blocked_category     TEXT,

  -- Post-call analysis as JSON.
  summary              TEXT
);

CREATE TABLE IF NOT EXISTS transcript_lines (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  role    TEXT NOT NULL,
  text    TEXT NOT NULL,
  at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcript_call
  ON transcript_lines (call_id, id);
