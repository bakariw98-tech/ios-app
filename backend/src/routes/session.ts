/**
 * Client-facing routes for the iOS app.
 *
 * The important thing about this file is what it cannot do: there is no
 * endpoint that places a call. `/session/start` hands the app a phone number to
 * display. The human dials it. That asymmetry is the product's compliance
 * posture expressed as an API surface (N4, docs/compliance.md).
 */

import type { FastifyInstance } from 'fastify';

import { config } from '../lib/config.js';
import * as store from '../lib/store.js';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the app needs to show the call screen.
   *
   * Returns a number for the user to dial — it does not dial anything.
   */
  app.get('/session/start', async () => ({
    phoneNumber: config.vapi.phoneNumber,
    instructions: {
      before:
        "Tap to call. I'll ask you about what's going on before anyone else " +
        'is on the line.',
      merge:
        "When you're ready, tap Add Call, dial them, then tap Merge Calls. " +
        "Tell me when they're on and I'll introduce myself.",
    },
  }));

  app.get<{ Params: { callId: string } }>(
    '/session/:callId/status',
    async (request, reply) => {
      const record = store.getCall(request.params.callId);
      if (!record) return reply.code(404).send({ error: 'not found' });

      return {
        callId: record.callId,
        phase: record.phase,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        blockedCategory: record.blockedCategory,
        hasSummary: Boolean(record.summary),
      };
    },
  );

  app.get<{ Params: { callId: string } }>(
    '/session/:callId/transcript',
    async (request, reply) => {
      const record = store.getCall(request.params.callId);
      if (!record) return reply.code(404).send({ error: 'not found' });
      return { transcript: record.transcript };
    },
  );

  app.get<{ Params: { callId: string } }>(
    '/session/:callId/summary',
    async (request, reply) => {
      const record = store.getCall(request.params.callId);
      if (!record) return reply.code(404).send({ error: 'not found' });
      if (!record.summary) {
        // Analysis runs a few seconds after hangup.
        return reply.code(202).send({ status: 'pending' });
      }
      return record.summary;
    },
  );
}
