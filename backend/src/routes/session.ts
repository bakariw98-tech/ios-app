/**
 * Client-facing routes for the iOS app.
 *
 * The important thing about this file is what it cannot do: there is no
 * endpoint that places a call. `/session/start` hands the app a phone number to
 * display. The human dials it. That asymmetry is the product's compliance
 * posture expressed as an API surface (N4, docs/compliance.md).
 */

import type { Hono } from 'hono';

import type { AppBindings } from '../app.js';

export function registerSessionRoutes(app: Hono<AppBindings>): void {
  /**
   * Everything the app needs to show the call screen.
   *
   * Returns a number for the user to dial — it does not dial anything.
   */
  app.get('/session/start', (c) =>
    c.json({
      phoneNumber: c.get('config').vapi.phoneNumber,
      instructions: {
        before:
          "Tap to call. I'll ask you about what's going on before anyone else " +
          'is on the line.',
        merge:
          "When you're ready, tap Add Call, dial them, then tap Merge Calls. " +
          "I'll hear them and introduce myself.",
      },
    }),
  );

  app.get('/session/:callId/status', async (c) => {
    const record = await c.get('store').get(c.req.param('callId'));
    if (!record) return c.json({ error: 'not found' }, 404);

    return c.json({
      callId: record.callId,
      phase: record.phase,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      blockedCategory: record.blockedCategory,
      hasSummary: Boolean(record.summary),
    });
  });

  app.get('/session/:callId/transcript', async (c) => {
    const store = c.get('store');
    const callId = c.req.param('callId');

    const record = await store.get(callId);
    if (!record) return c.json({ error: 'not found' }, 404);

    return c.json({ transcript: await store.getTranscript(callId) });
  });

  app.get('/session/:callId/summary', async (c) => {
    const record = await c.get('store').get(c.req.param('callId'));
    if (!record) return c.json({ error: 'not found' }, 404);

    // Analysis runs a few seconds after hangup.
    if (!record.summary) return c.json({ status: 'pending' }, 202);

    return c.json(record.summary);
  });
}
