/**
 * In-person mode's only endpoint. See ADR-005.
 *
 * The iOS app POSTs a brief, gets back a short-lived OpenAI client secret,
 * and connects to OpenAI directly over WebRTC using it — this Worker is out
 * of the loop for the actual audio. See src/lib/openaiRealtime.ts for why.
 */

import type { Hono } from 'hono';

import type { AppBindings } from '../app.js';
import {
  BriefSchema,
  CORRECTION_MARKER_PREFIX,
  CORRECTION_MARKER_SUFFIX,
  buildInPersonInstructions,
} from '../domain/inPersonBrief.js';
import { mintEphemeralSession } from '../lib/openaiRealtime.js';

const VOICES = ['marin', 'cedar'] as const;
/**
 * Warmer of the two realtime-exclusive voices — a better fit for a live,
 * improvised, conversational register than the phone-call delegate's
 * deliberately flatter `marin` (see assistants/shared.ts). Overridable per
 * request since this is a product-tuning knob, not a compliance one.
 */
const DEFAULT_VOICE = 'cedar';

export function registerRealtimeRoutes(app: Hono<AppBindings>): void {
  app.post('/realtime/session', async (c) => {
    const { openai } = c.get('config');
    if (!openai) {
      return c.json({ error: 'in-person mode is not configured' }, 503);
    }

    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = BriefSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid brief', issues: parsed.error.issues },
        400,
      );
    }

    const requestedVoice =
      typeof (body as { voice?: unknown }).voice === 'string'
        ? (body as { voice: string }).voice
        : undefined;
    const voice = (VOICES as readonly string[]).includes(requestedVoice ?? '')
      ? (requestedVoice as (typeof VOICES)[number])
      : DEFAULT_VOICE;

    const instructions = buildInPersonInstructions(parsed.data);

    try {
      const session = await mintEphemeralSession(openai.apiKey, {
        voice,
        instructions,
      });

      return c.json({
        clientSecret: session.clientSecret,
        expiresAt: session.expiresAt,
        model: session.model,
        voice: session.voice,
        // Sent so every client reads the correction-marker format at runtime
        // instead of hardcoding a third copy of it. It's already duplicated
        // once by necessity (inPersonBrief.ts's prompt vs.
        // RealtimeSessionClient.swift's Swift literal, kept in sync by
        // convention since one side is TypeScript and the other Swift) — a
        // browser client hardcoding a third copy would make it a 3-way drift
        // risk instead of a 2-way one. See docs/technical-decisions.md,
        // ADR-005.
        correctionMarker: {
          prefix: CORRECTION_MARKER_PREFIX,
          suffix: CORRECTION_MARKER_SUFFIX,
        },
      });
    } catch (error) {
      // Never surface OPENAI_API_KEY or any part of it in the response —
      // only the fact that minting failed and OpenAI's own status text,
      // which openaiRealtime.ts already scrubbed of the Authorization header.
      console.error('Failed to mint OpenAI Realtime session:', error);
      return c.json({ error: 'could not start a realtime session' }, 502);
    }
  });
}
