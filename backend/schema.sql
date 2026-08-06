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

-- Diagnostic log for the Vapi webhook secret handshake. Written on every
-- POST to /vapi/webhook, success or failure, so a live "unauthorized" can be
-- diagnosed by querying this table instead of needing log access we don't
-- have.
--
-- Never stores the secret, a hash of it, or any fragment of it — only the
-- header shape it arrived in, the length of the value that was sent, and
-- whether it matched. See the comment on logAuthAttempt in
-- src/routes/webhook.ts for why that's enough to diagnose a mismatch.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  header_shape    TEXT NOT NULL,
  provided_length INTEGER,
  matched         INTEGER NOT NULL
);
