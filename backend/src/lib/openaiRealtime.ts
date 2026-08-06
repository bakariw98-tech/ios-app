/**
 * Mints ephemeral client secrets for OpenAI's Realtime API.
 *
 * Session-object shape re-verified against
 * https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret
 * on 2026-08-06: the nested `audio.input.format` / `audio.output` objects,
 * `semantic_vad` turn detection, and session-level `output_modalities` below
 * are all current. Re-check before relying on this if OpenAI's Realtime API
 * surface has moved.
 *
 * The flow: our backend holds the real `OPENAI_API_KEY` and calls this
 * endpoint server-side to mint a short-lived client secret pre-configured
 * with the session's instructions, model, and voice. That secret — never the
 * real key — is handed to the iOS app, which uses it to open a WebRTC peer
 * connection directly to OpenAI. Audio never transits this Worker: Workers
 * can't relay raw WebRTC media anyway, and this is the architecture OpenAI
 * itself recommends for client apps (mint server-side, connect client-side).
 */

/**
 * Realtime model IDs go stale. `gpt-realtime-2025-08-28` was correct when this
 * was written and had silently been retired by the time the first real request
 * was made against it — OpenAI rejects the whole session, which surfaces as a
 * generic failure a long way from the cause. Verify this against
 * https://developers.openai.com/api/docs/models before assuming a session
 * failure is anything more interesting than this constant being out of date.
 */
const REALTIME_MODEL = 'gpt-realtime-2.1';

export interface RealtimeVoiceConfig {
  model?: string;
  voice: 'marin' | 'cedar';
  instructions: string;
}

export interface EphemeralSession {
  /** The short-lived client secret the iOS app uses to authenticate its own WebRTC connection to OpenAI. Never the real API key. */
  clientSecret: string;
  /** ISO 8601. The app should treat the session as unusable after this and request a new one. */
  expiresAt: string;
  model: string;
  voice: string;
}

interface OpenAiClientSecretResponse {
  value: string;
  expires_at?: number;
  session?: { model?: string; audio?: { output?: { voice?: string } } };
}

export async function mintEphemeralSession(
  apiKey: string,
  config: RealtimeVoiceConfig,
): Promise<EphemeralSession> {
  const model = config.model ?? REALTIME_MODEL;

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model,
        instructions: config.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: {
              type: 'semantic_vad',
              // The other person interrupting mid-sentence is normal
              // real-world conversation, not an error — the model must yield
              // immediately rather than talk over them.
              interrupt_response: true,
              create_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcm' },
            voice: config.voice,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // The caller surfaces this message to clients (see routes/realtime.ts), so
    // redact rather than trust that OpenAI never echoes the credential back.
    // Structural guarantee, not an assumption about someone else's error text.
    const safeBody = apiKey ? body.split(apiKey).join('[redacted]') : body;
    throw new Error(
      `OpenAI Realtime session creation failed: ${response.status} ${safeBody}`,
    );
  }

  const data = (await response.json()) as OpenAiClientSecretResponse;

  return {
    clientSecret: data.value,
    expiresAt: data.expires_at
      ? new Date(data.expires_at * 1000).toISOString()
      : new Date(Date.now() + 60_000).toISOString(),
    model: data.session?.model ?? model,
    voice: data.session?.audio?.output?.voice ?? config.voice,
  };
}
