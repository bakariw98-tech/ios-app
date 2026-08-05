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
import { buildDisclosure } from '../domain/disclosure.js';
import { IntentSchema } from '../domain/intent.js';
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
        return reply.send(handleTranscript(message, callId));

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

function handleTranscript(message: VapiMessage, callId?: string) {
  // Partials fire constantly; only keep finals.
  if (!callId || message.transcriptType !== 'final' || !message.transcript) {
    return {};
  }

  store.appendTranscript(callId, {
    role: message.role ?? 'user',
    text: message.transcript,
    at: new Date().toISOString(),
  });

  return {};
}

async function handleToolCalls(message: VapiMessage, callId?: string) {
  const results = [];

  for (const toolCall of message.toolCalls ?? []) {
    const args =
      typeof toolCall.function.arguments === 'string'
        ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
        : toolCall.function.arguments;

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
    store.upsertCall(callId, { intent, phase: 'delegating' });
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
