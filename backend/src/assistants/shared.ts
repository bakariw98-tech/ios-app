/**
 * Shared Vapi/Realtime configuration.
 *
 * Voice constraint (from the brief): `marin` and `cedar` are the two
 * realtime-exclusive higher-quality voices. `alloy`/`echo`/`shimmer` work but
 * are lower quality; `ash`/`ballad`/`coral`/`fable`/`onyx`/`nova` are not
 * supported by realtime models at all.
 */

/** Voices actually supported by OpenAI realtime models. */
export const REALTIME_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

/** The two we're willing to ship. */
export const PREFERRED_VOICES = ['marin', 'cedar'] as const;
export type PreferredVoice = (typeof PREFERRED_VOICES)[number];

/**
 * Was `gpt-realtime-2025-08-28`, which OpenAI has since retired. Worth knowing
 * if phone mode is picked back up: its open bug is a call that connects,
 * authenticates, then ends instantly with no transcript — exactly what a
 * rejected model ID looks like from Vapi's side, since Vapi passes this
 * straight through to OpenAI and the session never opens. Check this before
 * re-debugging webhooks or secrets. See README.md.
 */
export const REALTIME_MODEL = 'gpt-realtime-2.1';

/**
 * Interview uses cedar (warmer, better for drawing someone out); the delegate
 * uses marin (clearer, better for structured communication). Product tuning,
 * not compliance — safe to change.
 */
export const VOICE_INTERVIEW: PreferredVoice = 'cedar';
export const VOICE_DELEGATE: PreferredVoice = 'marin';

export interface RealtimeModelConfig {
  provider: 'openai';
  model: typeof REALTIME_MODEL;
  temperature?: number;
  messages: Array<{ role: 'system'; content: string }>;
}

export interface RealtimeVoiceConfig {
  provider: 'openai';
  voiceId: PreferredVoice;
}

export function realtimeModel(
  systemPrompt: string,
  temperature = 0.7,
): RealtimeModelConfig {
  return {
    provider: 'openai',
    model: REALTIME_MODEL,
    temperature,
    // Vapi converts system messages into Realtime session instructions during
    // WebSocket init — realtime models take instructions via session config
    // rather than as chat messages.
    messages: [{ role: 'system', content: systemPrompt }],
  };
}

export function realtimeVoice(voiceId: PreferredVoice): RealtimeVoiceConfig {
  return { provider: 'openai', voiceId };
}

/**
 * Transcriber is still worth configuring even with a speech-to-speech model —
 * it's what populates the transcript artifacts we surface in-app and feed to
 * call analysis.
 */
export const TRANSCRIBER = {
  provider: 'deepgram',
  model: 'nova-3',
  language: 'en',
} as const;

/**
 * Recording is off.
 *
 * Vapi records by default. Several states require all-party consent to *record*,
 * which is a separate question from consent to talk to an AI — our disclosure
 * covers the latter and does not obviously cover the former. Rather than leave
 * that unresolved while real calls happen, recording is disabled until someone
 * decides deliberately.
 *
 * Transcripts still work (that's the transcriber, not the recorder), so post-call
 * analysis and summaries are unaffected. See ADR-004, "Adjacent, unresolved".
 *
 * If you turn this on, the disclosure's consent question has to mention
 * recording — and that changes a frozen string, so read docs/compliance.md first.
 */
export const ARTIFACT_PLAN = {
  recordingEnabled: false,
  videoRecordingEnabled: false,
} as const;
