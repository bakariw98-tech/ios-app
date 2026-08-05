/**
 * MCP connector.
 *
 * Exposes exactly three tools: `start_interview`, `get_call_status`,
 * `get_summary`.
 *
 * It deliberately does NOT expose `place_call`, and this is the single most
 * important fact about this file. Placing a call is always a manual, in-app
 * human action. An agent with a `place_call` tool is an autodialer with extra
 * steps, and every line of reasoning in docs/compliance.md depends on that not
 * existing.
 *
 * Note that `start_interview` does not start a call either — it returns the
 * number for a human to dial. The name is from the brief; the semantics are
 * "prepare a session," not "initiate contact."
 *
 * This runs as a local Node process over stdio and talks to the deployed Worker
 * over HTTP. It holds no state of its own.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BACKEND_URL = (
  process.env.BACKEND_URL ?? 'http://localhost:8787'
).replace(/\/+$/, '');

async function getJson(path: string): Promise<
  { ok: true; data: unknown } | { ok: false; error: string }
> {
  try {
    const response = await fetch(`${BACKEND_URL}${path}`);
    if (response.status === 404) return { ok: false, error: 'No such call.' };
    if (response.status === 202) {
      return { ok: false, error: 'Analysis still running. Try again shortly.' };
    }
    if (!response.ok) {
      return { ok: false, error: `Backend returned ${response.status}.` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the backend at ${BACKEND_URL}: ${String(error)}`,
    };
  }
}

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
});

const failure = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'conversation-delegation',
    version: '0.1.0',
  });

  server.registerTool(
    'start_interview',
    {
      title: 'Start an interview session',
      description:
        'Prepare a delegation session and return the phone number the user ' +
        'must dial themselves. This does NOT place a call — no tool in this ' +
        'connector can place a call. The user dials manually, always.',
      inputSchema: {},
    },
    async () => {
      const result = await getJson('/session/start');
      if (!result.ok) return failure(result.error);

      const session = result.data as { phoneNumber: string };
      return text({
        phoneNumber: session.phoneNumber,
        nextStep:
          'The user dials this number themselves from their phone. Once ' +
          'connected, the assistant interviews them, and they merge the ' +
          'recipient in via their phone’s Add Call / Merge Calls controls.',
      });
    },
  );

  server.registerTool(
    'get_call_status',
    {
      title: 'Get call status',
      description:
        'Current phase of a delegation call: interviewing, awaiting_recipient, ' +
        'delegating, ended, or blocked.',
      inputSchema: { callId: z.string().describe('The Vapi call id.') },
    },
    async ({ callId }) => {
      const result = await getJson(
        `/session/${encodeURIComponent(callId)}/status`,
      );
      return result.ok ? text(result.data) : failure(result.error);
    },
  );

  server.registerTool(
    'get_summary',
    {
      title: 'Get call summary',
      description:
        'Post-call summary: what was discussed, what was answered, and ' +
        'whether the goal was achieved. Available a few seconds after the ' +
        'call ends.',
      inputSchema: { callId: z.string().describe('The Vapi call id.') },
    },
    async ({ callId }) => {
      const result = await getJson(
        `/session/${encodeURIComponent(callId)}/summary`,
      );
      if (!result.ok) return failure(result.error);

      // Recording URL is intentionally withheld from the MCP surface. An agent
      // asking how the call went does not need the audio of it. (Recording is
      // also disabled entirely at present — see ADR-004.)
      const { recordingUrl: _recordingUrl, ...shareable } =
        result.data as Record<string, unknown>;

      return text(shareable);
    },
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
}
