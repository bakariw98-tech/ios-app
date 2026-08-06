/**
 * Vapi server webhook. One route, switched on `message.type`. See ADR-003.
 *
 * Timing constraint: `assistant-request`, `tool-calls`,
 * `transfer-destination-request` and `handoff-destination-request` require a
 * response, and `assistant-request` has a ~7.5 second budget. Nothing slow may
 * happen inline on those paths. (That budget is the reason this runs on
 * Workers rather than a free-tier container that cold-starts — see docs/SETUP.md.)
 */

import type { Context, Hono } from 'hono';

import type { AppBindings } from '../app.js';
import { delegateAssistant } from '../assistants/delegate.js';
import { interviewAssistant } from '../assistants/interview.js';
import { assertValidDisclosure, buildDisclosure } from '../domain/disclosure.js';
import { IntentSchema } from '../domain/intent.js';
import { looksLikeNewParty, violatesQuietMode } from '../domain/mergeWindow.js';
import { type BlockCategory, block } from '../domain/safety.js';
import * as vapi from '../lib/vapi.js';

interface VapiMessage {
  type: string;
  call?: { id: string; monitor?: { controlUrl?: string } };
  status?: string;
  transcriptType?: string;
  role?: 'assistant' | 'user';
  transcript?: string;
  variableValues?: unknown;
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
  artifact?: { transcript?: string; recordingUrl?: string };
  analysis?: {
    summary?: string;
    structuredData?: Record<string, unknown>;
    successEvaluation?: string;
  };
  endedReason?: string;
}

type Ctx = Context<AppBindings>;

/**
 * Constant-time comparison.
 *
 * Workers have no `node:crypto` `timingSafeEqual`, so this is the hand-rolled
 * equivalent: fixed-length XOR accumulation with no early return.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < provided.length; i++) {
    difference |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Pull the shared secret off the request, whichever way Vapi was configured to
 * send it.
 *
 * Vapi's dashboard offers two routes to the same thing — a custom HTTP header,
 * or a "Bearer Token" credential which may or may not prepend `Bearer ` — and
 * which one you get depends on where in the UI you set it up. Accepting all
 * three shapes removes a configuration mismatch that is invisible from our side
 * (it just looks like every webhook is unauthorised).
 *
 * This does not weaken anything: the same secret must match either way.
 */
function extractSecret(c: Ctx): string | null {
  const direct = c.req.header('x-vapi-secret');
  if (direct) return direct;

  const authorization = c.req.header('authorization');
  if (!authorization) return null;

  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  return bearer ? bearer[1]!.trim() : authorization.trim();
}

export function registerWebhookRoutes(app: Hono<AppBindings>): void {
  app.post('/vapi/webhook', async (c) => {
    const config = c.get('config');
    const provided = extractSecret(c);

    if (!provided || !secretsMatch(provided, config.vapi.webhookSecret)) {
      // No body logging on unverified requests — they may be hostile, and the
      // bodies contain conversation content.
      console.warn('Rejected webhook with bad or missing secret');
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = (await c.req.json().catch(() => null)) as {
      message?: VapiMessage;
    } | null;
    const message = body?.message;
    if (!message) return c.json({ error: 'no message' }, 400);

    const callId = message.call?.id;

    switch (message.type) {
      case 'status-update':
        return c.json(await handleStatusUpdate(c, message, callId));

      case 'transcript':
        return c.json(await handleTranscript(c, message, callId));

      case 'tool-calls':
        return c.json(await handleToolCalls(c, message, callId));

      case 'handoff-destination-request':
        return c.json(await handleHandoffRequest(c, message, callId));

      case 'assistant-request':
        return c.json({ assistant: interviewAssistant(config.webhookUrl) });

      case 'end-of-call-report':
        return c.json(await handleEndOfCall(c, message, callId));

      default:
        return c.json({});
    }
  });
}

async function handleStatusUpdate(
  c: Ctx,
  message: VapiMessage,
  callId?: string,
) {
  if (!callId) return {};

  await c.get('store').upsert(callId, {
    // controlUrl arrives with the call object; we need it for the disclosure
    // backstop, so capture it the first time we see it.
    ...(message.call?.monitor?.controlUrl && {
      controlUrl: message.call.monitor.controlUrl,
    }),
    ...(message.status === 'ended' && {
      phase: 'ended' as const,
      endedAt: new Date().toISOString(),
    }),
  });

  return {};
}

async function handleTranscript(c: Ctx, message: VapiMessage, callId?: string) {
  // Partials fire constantly; only keep finals.
  if (!callId || message.transcriptType !== 'final' || !message.transcript) {
    return {};
  }

  const store = c.get('store');
  const role = message.role ?? 'user';
  const text = message.transcript;

  await store.appendTranscript(callId, {
    role,
    text,
    at: new Date().toISOString(),
  });

  // Merge-window tripwire. Only meaningful while armed — in ordinary
  // conversation "hello" means nothing, and a long assistant turn is fine.
  const record = await store.get(callId);
  if (record?.phase === 'awaiting_recipient' && !record.disclosureDelivered) {
    // Note both parties arrive as role "user": the carrier merges them onto one
    // mono leg, so Vapi cannot tell them apart. That's exactly why this is a
    // coarse backstop and the model's ear is the primary detector.
    if (role === 'user' && looksLikeNewParty(text)) {
      await forceDisclosure(c, callId, 'heard a greeting from a new party');
    } else if (role === 'assistant' && violatesQuietMode(text)) {
      await forceDisclosure(
        c,
        callId,
        'assistant broke quiet mode during the merge window',
      );
    }
  }

  return {};
}

/**
 * Speak the disclosure ourselves, right now.
 *
 * This should never fire — the model is meant to hand off, and the delegate's
 * firstMessage is the disclosure. If we get here, either the model missed the
 * recipient arriving or it started talking about the interview while someone
 * new was listening. Both are bugs that need a human to look at the transcript.
 *
 * We say it anyway, because a duplicated introduction is a small cost and an
 * undisclosed one is the thing we exist to prevent.
 */
async function forceDisclosure(
  c: Ctx,
  callId: string,
  reason: string,
): Promise<void> {
  const store = c.get('store');
  const record = await store.get(callId);

  if (!record?.controlUrl || !record.userFirstName) {
    console.error(
      `COMPLIANCE: needed to force disclosure on ${callId} (${reason}) but ` +
        'could not — no control URL or no user first name',
    );
    return;
  }

  // Claim atomically. Two webhook events arriving together must not both speak
  // the introduction — on Workers those can genuinely run concurrently.
  if (!(await store.claimDisclosure(callId))) return;

  await store.upsert(callId, {
    backstopFired: true,
    handoffTrigger: 'server_backstop',
  });

  console.error(
    `COMPLIANCE BACKSTOP on ${callId}: ${reason}. The assistant should have ` +
      'handed off and did not. Review this call.',
  );

  try {
    await vapi.say(record.controlUrl, buildDisclosure(record.userFirstName));
  } catch (error) {
    console.error(`Backstop say() failed on ${callId}:`, error);
  }
}

async function handleToolCalls(c: Ctx, message: VapiMessage, callId?: string) {
  const store = c.get('store');
  const results = [];

  for (const toolCall of message.toolCalls ?? []) {
    const args =
      typeof toolCall.function.arguments === 'string'
        ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
        : toolCall.function.arguments;

    if (toolCall.function.name === 'arm_for_merge') {
      const userFirstName = String(args.userFirstName ?? '').trim();

      // Build the disclosure now, while there's still time to fail safely. If
      // it can't be built we want to know before anyone is on the line, not at
      // the moment we need to speak it.
      try {
        assertValidDisclosure(buildDisclosure(userFirstName));
      } catch {
        results.push({
          toolCallId: toolCall.id,
          result:
            "I don't have the user's first name yet. Ask for it, then call " +
            'arm_for_merge again before coaching them through the merge.',
        });
        continue;
      }

      if (callId) {
        await store.upsert(callId, {
          phase: 'awaiting_recipient',
          armedAt: new Date().toISOString(),
          userFirstName,
        });
      }

      results.push({
        toolCallId: toolCall.id,
        result:
          'Merge window open. From now until you hand off: merge coaching and ' +
          'reassurance only. Nothing about the situation — assume they can ' +
          'already hear you. Hand off the moment you hear anyone who is not ' +
          `${userFirstName}, or if you are unsure.`,
      });
      continue;
    }

    if (toolCall.function.name === 'cancel_merge') {
      if (callId) {
        await store.upsert(callId, {
          phase: 'interviewing',
          armedAt: undefined,
        });
      }
      results.push({
        toolCallId: toolCall.id,
        result: 'Merge window closed. Back to the interview as normal.',
      });
      continue;
    }

    if (toolCall.function.name === 'flag_blocked_situation') {
      const category = args.category as BlockCategory;
      const refusal = block(category);

      if (callId) {
        await store.upsert(callId, {
          phase: 'blocked',
          blockedCategory: category,
        });
      }

      // Hand the assistant the exact words. The prompt tells it to say them
      // verbatim and stop — we don't let the model compose its own refusal for
      // these four categories.
      results.push({ toolCallId: toolCall.id, result: refusal.spokenRefusal });
      continue;
    }

    results.push({
      toolCallId: toolCall.id,
      result: `Unknown tool: ${toolCall.function.name}`,
    });
  }

  return { results };
}

/**
 * Resolve the delegate assistant, built from the intent object Vapi extracted
 * during the interview.
 */
async function handleHandoffRequest(
  c: Ctx,
  message: VapiMessage,
  callId?: string,
) {
  const store = c.get('store');
  const parsed = IntentSchema.safeParse(message.variableValues);

  if (!parsed.success) {
    console.error(
      `Intent extraction failed at handoff on ${callId}:`,
      parsed.error.issues,
    );

    // Fail closed and audibly. Never hand a recipient an assistant that does
    // not know what it is allowed to say.
    await failClosed(c, callId);

    return {
      error:
        'Intent could not be assembled from the interview; refusing handoff.',
    };
  }

  const intent = parsed.data;

  if (callId) {
    const previous = await store.get(callId);

    if (previous && previous.phase !== 'awaiting_recipient') {
      // The model jumped straight to handoff without arming. Not dangerous —
      // the delegate still opens with the disclosure — but it means the quiet
      // window never applied, so the interview was live right up to the join.
      console.warn(
        `Handoff without arming on ${callId} (phase: ${previous.phase}) — ` +
          'merge window was skipped',
      );
    }

    await store.upsert(callId, {
      intent,
      phase: 'delegating',
      userFirstName: intent.userFirstName,
      // The delegate's firstMessage is the disclosure, so takeover delivers it.
      disclosureDelivered: true,
      handoffTrigger: previous?.handoffTrigger ?? 'voice_detected',
    });
  }

  return {
    destination: {
      type: 'assistant',
      assistant: delegateAssistant(intent, c.get('config').webhookUrl),
    },
  };
}

async function failClosed(c: Ctx, callId?: string): Promise<void> {
  if (!callId) return;
  const record = await c.get('store').get(callId);
  if (!record?.controlUrl) return;

  try {
    await vapi.say(
      record.controlUrl,
      "I'm sorry — something went wrong on my end and I'm not able to " +
        'continue safely. Nothing has been said. Please try again.',
      true,
    );
  } catch (error) {
    console.error(`Fail-closed say() failed on ${callId}:`, error);
  }
}

async function handleEndOfCall(c: Ctx, message: VapiMessage, callId?: string) {
  if (!callId) return {};

  const analysis = message.analysis;
  const structured = analysis?.structuredData;

  await c.get('store').upsert(callId, {
    phase: 'ended',
    endedAt: new Date().toISOString(),
    summary: {
      summary: analysis?.summary ?? '',
      structuredData: structured,
      successEvaluation: analysis?.successEvaluation,
      recordingUrl: message.artifact?.recordingUrl,
      endedReason: message.endedReason,
    },
  });

  // Compliance audit (ADR-003). These are not metrics to aggregate — either one
  // being false means the disclosure path has a bug and a real recipient was
  // affected. Surface loudly.
  if (structured) {
    if (structured.disclosureDelivered === false) {
      console.error(
        `COMPLIANCE on ${callId}: completed without AI disclosure — investigate now`,
      );
    }
    if (structured.consentObtained === false) {
      console.error(
        `COMPLIANCE on ${callId}: delivered without recipient consent — investigate now`,
      );
    }
    if (structured.boundariesRespected === false) {
      console.error(
        `BOUNDARY VIOLATION on ${callId}: assistant raised a never-say item`,
      );
    }
  }

  return {};
}
