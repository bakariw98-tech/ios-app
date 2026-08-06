/**
 * Regression test for a real incident: REALTIME_MODEL here was briefly
 * changed to match lib/openaiRealtime.ts's model string (gpt-realtime-2.1)
 * during a session that also fixed a genuinely retired model ID on OpenAI's
 * direct API. That fix did not apply here — phone mode goes through Vapi,
 * which maintains its own supported-model list and does not recognize
 * gpt-realtime-2.1 as of 2026-08-06 (https://docs.vapi.ai/openai-realtime).
 * The mistake broke real phone calls that same night: Vapi silently fell
 * back to a different, generic assistant persona instead of erroring.
 *
 * Nothing else in the test suite pinned this value, which is how a
 * "matching fix" landed unnoticed. This does.
 */

import { describe, expect, it } from 'vitest';

import { delegateAssistant } from '../src/assistants/delegate.js';
import { interviewAssistant } from '../src/assistants/interview.js';
import { REALTIME_MODEL } from '../src/assistants/shared.js';
import type { Intent } from '../src/domain/intent.js';

describe('assistants/shared.ts REALTIME_MODEL', () => {
  it('is the model string Vapi currently documents as supported, not OpenAI\'s direct-API string', () => {
    expect(REALTIME_MODEL).toBe('gpt-realtime-2025-08-28');
    // Deliberately NOT lib/openaiRealtime.ts's 'gpt-realtime-2.1' — see the
    // doc comment on this constant in src/assistants/shared.ts before ever
    // changing this assertion to match that one.
    expect(REALTIME_MODEL).not.toBe('gpt-realtime-2.1');
  });
});

const intent: Intent = {
  userFirstName: 'Sam',
  recipientName: 'Alex',
  relationship: 'friend',
  situation: 'test',
  feelings: 'test',
  pointsToConvey: ['test'],
  desiredOutcome: 'test',
  mustSay: [],
  neverSay: [],
  questionsToAsk: [],
  tone: 'warm',
};

// Regression test for the second, deeper bug found the same night as the
// model-ID one above: both assistants set a separate `transcriber` field
// (Deepgram), which Vapi's own docs say must be removed entirely for a
// Realtime assistant — OpenAI Realtime transcribes natively as part of the
// audio pipeline. Live calls with a transcriber field set got zero
// transcript relayed to our webhook and, on at least one call, a generic
// fallback assistant persona instead of ours ("I'm ChatGPT, how can I
// assist" — never anything either assistant's prompt would say) — Vapi
// failing silently rather than rejecting the config outright. See
// docs/technical-decisions.md's phone-mode-in-web amendment area / the
// REALTIME_MODEL doc comment in shared.ts for the fuller incident writeup.
describe('Realtime assistants never set a transcriber field', () => {
  it('interviewAssistant has no transcriber', () => {
    const assistant = interviewAssistant('https://example.test/webhook') as Record<
      string,
      unknown
    >;
    expect(assistant.transcriber).toBeUndefined();
    expect('transcriber' in assistant).toBe(false);
  });

  it('delegateAssistant has no transcriber', () => {
    const assistant = delegateAssistant(intent, 'https://example.test/webhook') as Record<
      string,
      unknown
    >;
    expect(assistant.transcriber).toBeUndefined();
    expect('transcriber' in assistant).toBe(false);
  });
});
