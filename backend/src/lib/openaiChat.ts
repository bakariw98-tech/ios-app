/**
 * Runs a single structured-output turn against OpenAI's Chat Completions API,
 * for the typed intake step (domain/inPersonIntake.ts). Not the Realtime
 * API — see lib/openaiRealtime.ts for that; this is a plain, non-streaming,
 * non-realtime call to a different endpoint and a different model.
 *
 * Chat Completions over the newer Responses API, deliberately: the intake's
 * message array maps 1:1 onto the transcript we already hold
 * ({role, content} pairs), and the output is one string at
 * `choices[0].message.content` rather than the Responses API's nested
 * `output[].content[].text`. Fewer moving parts for the same guarantee, and
 * Structured Outputs (`response_format: json_schema`) is supported on both.
 */

/**
 * Chat model IDs go stale — same lesson `lib/openaiRealtime.ts`'s
 * REALTIME_MODEL already cost a debug cycle to learn. Verify against
 * https://developers.openai.com/api/docs/models before assuming a failure
 * here is anything more interesting than this constant being out of date.
 * Chosen for cost: this is an unauthenticated, per-keystroke-adjacent
 * endpoint (see routes/intake.ts's cost note), so the cheapest tier that
 * supports Structured Outputs is the right default, not the most capable one.
 */
export const INTAKE_MODEL = 'gpt-5.6-luna';

/** A question or a paragraph, never more — keeps latency and cost bounded per turn. */
const MAX_COMPLETION_TOKENS = 400;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StructuredCompletionRequest {
  apiKey: string;
  model?: string;
  messages: ChatMessage[];
  /** A short, unique-per-call name for OpenAI's json_schema.name field. */
  schemaName: string;
  /** The literal JSON Schema object — see INTAKE_REPLY_JSON_SCHEMA's doc comment on why hand-written. */
  jsonSchema: Record<string, unknown>;
}

/**
 * Returns the raw JSON string from `choices[0].message.content`. The caller
 * (routes/intake.ts) does the Zod parse, keeping the domain schema the one
 * source of truth for validation rather than duplicating it here.
 */
export async function runStructuredCompletion(
  request: StructuredCompletionRequest,
): Promise<string> {
  const model = request.model ?? INTAKE_MODEL;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: request.messages,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.jsonSchema,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Same structural redaction as openaiRealtime.ts, duplicated rather than
    // factored into a shared helper: that file is not to be touched, and a
    // three-line duplication is cheaper than a shared abstraction across two
    // otherwise-unrelated OpenAI endpoints.
    const safeBody = request.apiKey ? body.split(request.apiKey).join('[redacted]') : body;
    throw new Error(`OpenAI chat completion failed: ${response.status} ${safeBody}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  };

  const message = data.choices?.[0]?.message;

  // Strict mode can return a refusal INSTEAD OF content — handle it
  // explicitly, or it surfaces as a baffling JSON.parse(undefined) error two
  // layers away from the actual cause.
  if (message?.refusal) {
    throw new Error(`OpenAI declined to answer: ${message.refusal}`);
  }
  if (!message?.content) {
    throw new Error('OpenAI returned no content and no refusal');
  }

  return message.content;
}
