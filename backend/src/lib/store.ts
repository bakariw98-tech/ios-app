/**
 * In-memory call store.
 *
 * Deliberately not a database yet — v1 is a small pilot and the shape of what we
 * need to persist is still moving. Swap for Postgres before more than one
 * backend instance runs, because this obviously does not survive a restart or
 * share across processes.
 *
 * Note what is NOT stored: recipient phone numbers. We never learn them (the
 * user dials, not us) and we should keep it that way — it's the cleanest
 * possible answer to "what do you hold about the person who was called."
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
  /** Vapi live-call control URL, from monitor.controlUrl. */
  controlUrl?: string;
  /** Set once the disclosure has been observed or injected. Compliance backstop state. */
  disclosureDelivered: boolean;
  /** When the merge window was armed, if it has been. */
  armedAt?: string;
  /** Captured at arm time so the server can speak the disclosure unaided. */
  userFirstName?: string;
  /** True if the server had to force the disclosure. Always a bug — investigate. */
  backstopFired?: boolean;
  /** What ended the merge window. Recorded for compliance review. */
  handoffTrigger?: HandoffTrigger;
  blockedCategory?: string;
  transcript: TranscriptLine[];
  summary?: CallSummary;
}

const calls = new Map<string, CallRecord>();

export function upsertCall(
  callId: string,
  patch: Partial<CallRecord> = {},
): CallRecord {
  const existing = calls.get(callId);
  const record: CallRecord = existing ?? {
    callId,
    phase: 'interviewing',
    startedAt: new Date().toISOString(),
    disclosureDelivered: false,
    transcript: [],
  };
  Object.assign(record, patch);
  calls.set(callId, record);
  return record;
}

export function getCall(callId: string): CallRecord | undefined {
  return calls.get(callId);
}

export function appendTranscript(callId: string, line: TranscriptLine): void {
  const record = upsertCall(callId);
  record.transcript.push(line);
}

/** Test seam. */
export function _reset(): void {
  calls.clear();
}
