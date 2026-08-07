/**
 * Twilio routes — the new phone-mode backend (docs/technical-decisions.md,
 * ADR-006). Phase 2 skeleton: enough to answer a call, verify it's genuinely
 * from Twilio, and hand the live audio off to CallRelay. No D1 lifecycle
 * wiring yet (Phase 3), no compliance tooling yet (Phase 4/5) — see
 * relay/CallRelay.ts's doc comment for the same caveat from the other side.
 */

import type { Hono } from 'hono';

import type { AppBindings } from '../app.js';
import {
  buildHangupTwiml,
  buildRejectTwiml,
  buildStreamTwiml,
  signStreamToken,
  verifyStreamToken,
  verifyTwilioSignature,
} from '../lib/twilio.js';

async function verifiedFormParams(
  req: { parseBody(): Promise<Record<string, unknown>> },
): Promise<Record<string, string>> {
  const body = await req.parseBody();
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') params[key] = value;
  }
  return params;
}

export function registerTwilioRoutes(app: Hono<AppBindings>): void {
  // Dashboard/validator pings, same reason GET /vapi/webhook exists.
  app.get('/twilio/voice', (c) => c.text('ok'));

  app.post('/twilio/voice', async (c) => {
    const config = c.get('config');

    if (!config.twilio || !config.openai) {
      // Graceful, not a bare 500 — a real caller hears a spoken reason and
      // the call ends cleanly rather than erroring out on Twilio's side.
      return c.body(
        buildHangupTwiml(
          "Sorry — phone mode isn't set up yet. Please try again later.",
        ),
        200,
        { 'Content-Type': 'text/xml' },
      );
    }

    const params = await verifiedFormParams(c.req);
    const signature = c.req.header('x-twilio-signature') ?? '';
    const valid = await verifyTwilioSignature(
      config.twilio.authToken,
      config.twilio.voiceWebhookUrl,
      params,
      signature,
    );

    if (!valid) {
      console.warn('Rejected /twilio/voice request with bad signature');
      return c.body(buildRejectTwiml(), 200, { 'Content-Type': 'text/xml' });
    }

    const callSid = params.CallSid;
    if (!callSid) {
      console.warn('/twilio/voice request had a valid signature but no CallSid');
      return c.body(buildRejectTwiml(), 200, { 'Content-Type': 'text/xml' });
    }

    const token = await signStreamToken(config.twilio.authToken, callSid);
    const streamUrl =
      `${config.twilio.streamUrlBase}/` +
      `${encodeURIComponent(callSid)}/${encodeURIComponent(token)}`;

    return c.body(buildStreamTwiml(streamUrl), 200, { 'Content-Type': 'text/xml' });
  });

  app.get('/twilio/stream/:callSid/:token', async (c) => {
    const config = c.get('config');
    if (!config.twilio) {
      return c.text('twilio not configured', 500);
    }

    const callSid = c.req.param('callSid');
    const token = c.req.param('token');
    const valid = await verifyStreamToken(config.twilio.authToken, callSid, token);
    if (!valid) {
      console.warn('Rejected /twilio/stream connection with bad or stale token');
      return c.text('unauthorized', 401);
    }

    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('expected a websocket upgrade', 426);
    }

    // One Durable Object instance per call, addressed by CallSid — see
    // relay/CallRelay.ts's doc comment for why a Durable Object at all.
    const id = c.env.CALL_RELAY.idFromName(callSid);
    const stub = c.env.CALL_RELAY.get(id);
    return stub.fetch(c.req.raw);
  });

  app.post('/twilio/status', async (c) => {
    const config = c.get('config');
    if (!config.twilio) {
      return c.text('twilio not configured', 500);
    }

    const params = await verifiedFormParams(c.req);
    const signature = c.req.header('x-twilio-signature') ?? '';
    const valid = await verifyTwilioSignature(
      config.twilio.authToken,
      config.twilio.statusWebhookUrl,
      params,
      signature,
    );

    if (!valid) {
      console.warn('Rejected /twilio/status request with bad signature');
      return c.text('unauthorized', 401);
    }

    // Phase 2: signature-verified but otherwise a no-op — D1 call lifecycle
    // (phase transitions, ended_at, post-call analysis triggering) is
    // Phase 3's job, not this skeleton's. Acknowledging with 200 is still
    // correct: an unhandled non-2xx here would make Twilio retry.
    return c.text('ok');
  });
}
