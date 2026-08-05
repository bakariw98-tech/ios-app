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
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config } from '../lib/config.js';
import * as store from '../lib/store.js';

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
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              phoneNumber: config.vapi.phoneNumber,
              nextStep:
                'The user dials this number themselves from their phone. ' +
                'Once connected, the assistant interviews them, and they ' +
                'merge the recipient in via their phone’s Add Call / ' +
                'Merge Calls controls.',
            },
            null,
            2,
          ),
        },
      ],
    }),
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
      const record = store.getCall(callId);
      if (!record) {
        return {
          content: [{ type: 'text' as const, text: `No call found: ${callId}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                callId: record.callId,
                phase: record.phase,
                startedAt: record.startedAt,
                endedAt: record.endedAt,
                blockedCategory: record.blockedCategory,
                summaryAvailable: Boolean(record.summary),
              },
              null,
              2,
            ),
          },
        ],
      };
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
      const record = store.getCall(callId);
      if (!record) {
        return {
          content: [{ type: 'text' as const, text: `No call found: ${callId}` }],
          isError: true,
        };
      }
      if (!record.summary) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                record.phase === 'ended'
                  ? 'Call ended; analysis still running. Try again shortly.'
                  : `Call is still in progress (phase: ${record.phase}).`,
            },
          ],
        };
      }

      // Recording URL is intentionally withheld from the MCP surface. An agent
      // asking how the call went does not need the audio of it.
      const { recordingUrl: _recordingUrl, ...shareable } = record.summary;

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(shareable, null, 2) },
        ],
      };
    },
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
}
