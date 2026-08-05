/**
 * Call store.
 *
 * Two implementations behind one interface: D1 in production, in-memory for
 * tests. Workers are stateless across requests and run in many isolates, so a
 * module-level Map is not an option in production — but it's the right thing
 * for tests, which want speed and isolation, not durability.
 *
 * Note what is NOT stored: recipient phone numbers. We never learn them (the
 * user dials, not us) and we should keep it that way.
 */

import type { Intent } from '../domain/intent.js';
import type { HandoffTrigger } from '../domain/mergeWindow.js';

export type CallPhase =
  | 'interviewing'
  /** In the merge window — armed, quiet, waiting for the recipient. */
  | 'awaiting_recipient'
  | 'delegating'
  | 'ended'
  | 'blocked';

export interface TranscriptLine {
  role: 'assistant' | 'user';
  text: string;
  at: string;
}

export interface CallSummary {
  summary: string;
  structuredData?: Record<string, unknown>;
  successEvaluation?: string;
  recordingUrl?: string;
  endedReason?: string;
}

export interface CallRecord {
  callId: string;
  phase: CallPhase;
  startedAt: string;
  endedAt?: string;
  intent?: Intent;
  controlUrl?: string;
  disclosureDelivered: boolean;
  armedAt?: string;
  userFirstName?: string;
  backstopFired?: boolean;
  handoffTrigger?: HandoffTrigger;
  blockedCategory?: string;
  summary?: CallSummary;
}

export interface Store {
  get(callId: string): Promise<CallRecord | undefined>;
  upsert(callId: string, patch: Partial<CallRecord>): Promise<CallRecord>;
  appendTranscript(callId: string, line: TranscriptLine): Promise<void>;
  getTranscript(callId: string): Promise<TranscriptLine[]>;

  /**
   * Atomically claim the right to deliver the disclosure.
   *
   * Returns true exactly once per call. Two webhook events arriving together —
   * entirely possible on Workers, where requests run concurrently across
   * isolates — must not both speak the introduction. The in-memory version
   * relied on single-threaded ordering; the D1 version is a conditional UPDATE,
   * which is genuinely atomic rather than merely usually-fine.
   */
  claimDisclosure(callId: string): Promise<boolean>;
}

function blank(callId: string): CallRecord {
  return {
    callId,
    phase: 'interviewing',
    startedAt: new Date().toISOString(),
    disclosureDelivered: false,
  };
}

// ---------------------------------------------------------------------------
// In-memory (tests)
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private calls = new Map<string, CallRecord>();
  private lines = new Map<string, TranscriptLine[]>();

  async get(callId: string): Promise<CallRecord | undefined> {
    return this.calls.get(callId);
  }

  async upsert(
    callId: string,
    patch: Partial<CallRecord> = {},
  ): Promise<CallRecord> {
    const record = this.calls.get(callId) ?? blank(callId);
    Object.assign(record, patch);
    this.calls.set(callId, record);
    return record;
  }

  async appendTranscript(
    callId: string,
    line: TranscriptLine,
  ): Promise<void> {
    await this.upsert(callId);
    const existing = this.lines.get(callId) ?? [];
    existing.push(line);
    this.lines.set(callId, existing);
  }

  async getTranscript(callId: string): Promise<TranscriptLine[]> {
    return this.lines.get(callId) ?? [];
  }

  async claimDisclosure(callId: string): Promise<boolean> {
    const record = this.calls.get(callId);
    if (!record || record.disclosureDelivered) return false;
    record.disclosureDelivered = true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// D1 (production)
// ---------------------------------------------------------------------------

interface Row {
  call_id: string;
  phase: string;
  started_at: string;
  ended_at: string | null;
  control_url: string | null;
  intent: string | null;
  disclosure_delivered: number;
  armed_at: string | null;
  user_first_name: string | null;
  backstop_fired: number;
  handoff_trigger: string | null;
  blocked_category: string | null;
  summary: string | null;
}

function toRecord(row: Row): CallRecord {
  return {
    callId: row.call_id,
    phase: row.phase as CallPhase,
    startedAt: row.started_at,
    ...(row.ended_at && { endedAt: row.ended_at }),
    ...(row.control_url && { controlUrl: row.control_url }),
    ...(row.intent && { intent: JSON.parse(row.intent) as Intent }),
    disclosureDelivered: row.disclosure_delivered === 1,
    ...(row.armed_at && { armedAt: row.armed_at }),
    ...(row.user_first_name && { userFirstName: row.user_first_name }),
    backstopFired: row.backstop_fired === 1,
    ...(row.handoff_trigger && {
      handoffTrigger: row.handoff_trigger as HandoffTrigger,
    }),
    ...(row.blocked_category && { blockedCategory: row.blocked_category }),
    ...(row.summary && { summary: JSON.parse(row.summary) as CallSummary }),
  };
}

/** Maps a CallRecord field to its column and serialised value. */
const COLUMNS: Record<string, (value: unknown) => [string, unknown]> = {
  phase: (v) => ['phase', v],
  endedAt: (v) => ['ended_at', v ?? null],
  controlUrl: (v) => ['control_url', v ?? null],
  intent: (v) => ['intent', v == null ? null : JSON.stringify(v)],
  disclosureDelivered: (v) => ['disclosure_delivered', v ? 1 : 0],
  armedAt: (v) => ['armed_at', v ?? null],
  userFirstName: (v) => ['user_first_name', v ?? null],
  backstopFired: (v) => ['backstop_fired', v ? 1 : 0],
  handoffTrigger: (v) => ['handoff_trigger', v ?? null],
  blockedCategory: (v) => ['blocked_category', v ?? null],
  summary: (v) => ['summary', v == null ? null : JSON.stringify(v)],
};

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async get(callId: string): Promise<CallRecord | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM calls WHERE call_id = ?')
      .bind(callId)
      .first<Row>();
    return row ? toRecord(row) : undefined;
  }

  async upsert(
    callId: string,
    patch: Partial<CallRecord> = {},
  ): Promise<CallRecord> {
    await this.db
      .prepare(
        'INSERT INTO calls (call_id, phase, started_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(call_id) DO NOTHING',
      )
      .bind(callId, 'interviewing', new Date().toISOString())
      .run();

    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const mapper = COLUMNS[field];
      if (!mapper) continue; // callId / startedAt are not patchable
      const [column, serialised] = mapper(value);
      assignments.push(`${column} = ?`);
      values.push(serialised);
    }

    if (assignments.length > 0) {
      await this.db
        .prepare(
          `UPDATE calls SET ${assignments.join(', ')} WHERE call_id = ?`,
        )
        .bind(...values, callId)
        .run();
    }

    const record = await this.get(callId);
    if (!record) throw new Error(`Call vanished during upsert: ${callId}`);
    return record;
  }

  async appendTranscript(
    callId: string,
    line: TranscriptLine,
  ): Promise<void> {
    await this.upsert(callId);
    await this.db
      .prepare(
        'INSERT INTO transcript_lines (call_id, role, text, at) VALUES (?, ?, ?, ?)',
      )
      .bind(callId, line.role, line.text, line.at)
      .run();
  }

  async getTranscript(callId: string): Promise<TranscriptLine[]> {
    const { results } = await this.db
      .prepare(
        'SELECT role, text, at FROM transcript_lines WHERE call_id = ? ORDER BY id',
      )
      .bind(callId)
      .all<{ role: string; text: string; at: string }>();

    return results.map((row) => ({
      role: row.role as 'assistant' | 'user',
      text: row.text,
      at: row.at,
    }));
  }

  async claimDisclosure(callId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE calls SET disclosure_delivered = 1 ' +
          'WHERE call_id = ? AND disclosure_delivered = 0',
      )
      .bind(callId)
      .run();

    // Exactly one caller sees changes === 1; everyone else loses the race.
    return result.meta.changes === 1;
  }
}
