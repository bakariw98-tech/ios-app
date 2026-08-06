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

import { REALTIME_MODEL } from '../src/assistants/shared.js';

describe('assistants/shared.ts REALTIME_MODEL', () => {
  it('is the model string Vapi currently documents as supported, not OpenAI\'s direct-API string', () => {
    expect(REALTIME_MODEL).toBe('gpt-realtime-2025-08-28');
    // Deliberately NOT lib/openaiRealtime.ts's 'gpt-realtime-2.1' — see the
    // doc comment on this constant in src/assistants/shared.ts before ever
    // changing this assertion to match that one.
    expect(REALTIME_MODEL).not.toBe('gpt-realtime-2.1');
  });
});
