/**
 * Vapi server webhook. One endpoint, switched on `message.type`. See ADR-003.
 *
 * Timing constraint: `assistant-request`, `tool-calls`,
 * `transfer-destination-request` and `handoff-destination-request` require a
 * response, and `assistant-request` has a ~7.5 second budget. Nothing slow may
 * happen inline on those paths.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import { delegateAssistant } from '../assistants/delegate.js';
import { interviewAssistant } from '../assistants/interview.js';
import { assertValidDisclosure, buildDisclosure } from '../domain/disclosure.js';
import { IntentSchema } from '../domain/intent.js';
import { looksLikeNewParty, violatesQuietMode } from '../domain/mergeWindow.js';
import { type BlockCategory, block } from '../domain/safety.js';
import { config } from '../lib/config.js';
import * as store from '../lib/store.js';
import * as vapi from '../lib/vapi.js';

interface VapiMessage {
  type: string;
  call?: { id: string; monitor?: { controlUrl?: string } };
  status?: string;
  transcriptType?: string;
  role?: 'assistant' | 'user';
  transcript?: string;
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
  artifact?: {
    transcript?: string;
    recordingUrl?: string;
    messages?: unknown[];
  };
  analysis?: {
    summary?: string;
    structuredData?: Record<string, unknown>;
    successEvaluation?: string;
  };
  endedReason?: string;
}

function verifySecret(request: FastifyRequest): boolean {
  const provided = request.headers['x-vapi-secret'];
  if (typeof provided !== 'string') return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(config.vapi.webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/vapi/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifySecret(request)) {
      // No body logging on unverified requests — they may be hostile, and the
      // bodies contain conversation content.
      request.log.warn('Rejected webhook with bad or missing secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const message = (request.body as { message?: VapiMessage })?.message;
    if (!message) return reply.code(400).send({ error: 'no message' });

    const callId = message.call?.id;

    switch (message.type) {
      case 'status-update':
        return reply.send(handleStatusUpdate(message, callId));

      case 'transcript':
        return reply.send(handleTranscript(message, callId, request));

      case 'tool-calls':
        return reply.send(await handleToolCalls(message, callId));

      case 'handoff-destination-request':
        return reply.send(handleHandoffRequest(message, callId, request));

      case 'assistant-request':
        return reply.send({
          assistant: interviewAssistant(config.webhookUrl),
        });

      case 'end-of-call-report':
        return reply.send(handleEndOfCall(message, callId, request));

      default:
        return reply.send({});
    }
  });
}

function handleStatusUpdate(message: VapiMessage, callId?: string) {
  if (!callId) return {};

  store.upsertCall(callId, {
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

function handleTranscript(
  message: VapiMessage,
  callId: string | undefined,
  request: FastifyRequest,
) {
  // Partials fire constantly; only keep finals.
  if (!callId || message.transcriptType !== 'final' || !message.transcript) {
    return {};
  }

  const role = message.role ?? 'user';
  const text = message.transcript;

  store.appendTranscript(callId, {
    role,
    text,
    at: new Date().toISOString(),
  });

  // Merge-window tripwire. Only meaningful while armed — in ordinary
  // conversation "hello" means nothing, and a long assistant turn is fine.
  const record = store.getCall(callId);
  if (record?.phase === 'awaiting_recipient' && !record.disclosureDelivered) {
    // Note both parties arrive as role "user": the carrier merges them onto one
    // mono leg, so Vapi cannot tell them apart. That's exactly why this is a
    // coarse backstop and the model's ear is the primary detector.
    if (role === 'user' && looksLikeNewParty(text)) {
      void forceDisclosure(callId, 'heard a greeting from a new party', request);
    } else if (role === 'assistant' && violatesQuietMode(text)) {
      void forceDisclosure(
        callId,
        'assistant broke quiet mode during the merge window',
        request,
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
  callId: string,
  reason: string,
  request: FastifyRequest,
): Promise<void> {
  const record = store.getCall(callId);
  if (!record?.controlUrl || !record.userFirstName) {
    request.log.error(
      { callId, reason, hasControlUrl: Boolean(record?.controlUrl) },
      'COMPLIANCE: needed to force disclosure but could not — no control URL or name',
    );
    return;
  }

  // Mark first: if the say() call is slow, a second transcript event must not
  // race us into speaking it twice.
  store.upsertCall(callId, {
    disclosureDelivered: true,
    backstopFired: true,
    handoffTrigger: 'server_backstop',
  });

  request.log.error(
    { callId, reason },
    'COMPLIANCE BACKSTOP: forcing disclosure — the assistant should have ' +
      'handed off and did not. Review this call.',
  );

  try {
    await vapi.say(record.controlUrl, buildDisclosure(record.userFirstName));
  } catch (error) {
    request.log.error({ err: error, callId }, 'Backstop say() failed');
  }
}

async function handleToolCalls(message: VapiMessage, callId?: string) {
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
        store.upsertCall(callId, {
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
        store.upsertCall(callId, { phase: 'interviewing', armedAt: undefined });
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
        store.upsertCall(callId, {
          phase: 'blocked',
          blockedCategory: category,
        });
      }

      // Hand the assistant the exact words. The prompt tells it to say them
      // verbatim and stop — we don't let the model compose its own refusal for
      // these four categories.
      results.push({
        toolCallId: toolCall.id,
        result: refusal.spokenRefusal,
      });
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
 *
 * This is also where the disclosure backstop is armed. The disclosure is already
 * guaranteed by `firstMessage` + `assistant-speaks-first`; the backstop covers
 * the case where the delegate config fails to build at all, in which case we
 * would rather speak the disclosure and drop the call than let a half-configured
 * assistant address the recipient.
 */
function handleHandoffRequest(
  message: VapiMessage,
  callId: string | undefined,
  request: FastifyRequest,
) {
  const parsed = IntentSchema.safeParse(
    (message as unknown as { variableValues?: unknown }).variableValues,
  );

  if (!parsed.success) {
    request.log.error(
      { callId, issues: parsed.error.issues },
      'Intent extraction failed at handoff',
    );

    // Fail closed and audibly. Never hand a recipient an assistant that does
    // not know what it is allowed to say.
    void failClosed(callId, request);

    return {
      error:
        'Intent could not be assembled from the interview; refusing handoff.',
    };
  }

  const intent = parsed.data;
  if (callId) {
    const previous = store.getCall(callId);

    if (previous && previous.phase !== 'awaiting_recipient') {
      // The model jumped straight to handoff without arming. Not dangerous —
      // the delegate still opens with the disclosure — but it means the quiet
      // window never applied, so the interview was live right up to the join.
      request.log.warn(
        { callId, phase: previous.phase },
        'Handoff without arming — merge window was skipped',
      );
    }

    store.upsertCall(callId, {
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
      assistant: delegateAssistant(intent, config.webhookUrl),
    },
  };
}

async function failClosed(
  callId: string | undefined,
  request: FastifyRequest,
): Promise<void> {
  if (!callId) return;
  const record = store.getCall(callId);
  if (!record?.controlUrl) return;

  try {
    await vapi.say(
      record.controlUrl,
      "I'm sorry — something went wrong on my end and I'm not able to " +
        "continue safely. Nothing has been said. Please try again.",
      true,
    );
  } catch (error) {
    request.log.error({ err: error, callId }, 'Fail-closed say() failed');
  }
}

function handleEndOfCall(
  message: VapiMessage,
  callId: string | undefined,
  request: FastifyRequest,
) {
  if (!callId) return {};

  const analysis = message.analysis;
  const structured = analysis?.structuredData;

  store.upsertCall(callId, {
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
      request.log.error(
        { callId },
        'COMPLIANCE: call completed without AI disclosure — investigate now',
      );
    }
    if (structured.consentObtained === false) {
      request.log.error(
        { callId },
        'COMPLIANCE: message delivered without recipient consent — investigate now',
      );
    }
    if (structured.boundariesRespected === false) {
      request.log.error(
        { callId },
        'BOUNDARY VIOLATION: assistant raised something on the never-say list',
      );
    }
  }

  return {};
}

/** Exported for tests. */
export const _internal = { verifySecret, buildDisclosure };
