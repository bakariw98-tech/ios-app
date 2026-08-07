/**
 * Server-to-server WebSocket connection to OpenAI's Realtime API.
 *
 * Deliberately separate from lib/openaiRealtime.ts, not a refactor of it —
 * that file mints ephemeral client secrets for in-person mode's browser
 * WebRTC path (audio never transits the Worker there) and has already cost
 * two live incidents this project; touching it for an unrelated purpose is
 * exactly the kind of "while I'm in here" change that caused the first one.
 * This is a genuinely different mechanism: the Twilio relay holds the real
 * audio itself (bridging it from a Twilio Media Stream), so it needs an
 * actual server-to-server socket, not a client secret.
 *
 * Workers can't use the global `new WebSocket()` constructor with custom
 * headers for an *outbound* connection. The technique — `fetch(url,
 * {headers: {Upgrade: 'websocket', ...}})`, then take `response.webSocket`
 * and call `.accept()` — was confirmed live against a real OpenAI Realtime
 * session during this migration's Phase 0 verification, not assumed from
 * docs alone.
 *
 * Model string: same as lib/openaiRealtime.ts's `gpt-realtime-2.1`, which is
 * a coincidence worth stating plainly rather than leaving implicit — this
 * path and in-person mode both talk to OpenAI's Realtime API directly and so
 * share OpenAI's own current model ID, in contrast to
 * assistants/shared.ts's REALTIME_MODEL, which is deliberately a different,
 * older string because it goes through Vapi's own compatibility layer. Keep
 * that distinction in mind before ever "fixing" one to match another.
 */

const REALTIME_MODEL = 'gpt-realtime-2.1';

const CONNECT_TIMEOUT_MS = 10_000;

export interface OpenAiRealtimeSocketOptions {
  apiKey: string;
  model?: string;
}

/**
 * Opens the socket and waits for `session.created` before resolving, so
 * callers never race sending `session.update` against a socket that isn't
 * ready yet.
 *
 * Throws — with the response status and a credential-redacted body — if the
 * connection itself fails. That's the direct antidote to this project's
 * established failure mode on the Vapi path (assistants/shared.ts's
 * REALTIME_MODEL doc comment): a call that connects, "succeeds," and
 * produces nothing, with the actual rejection buried somewhere unreachable.
 * Here a rejected connection is loud by construction.
 */
export async function openOpenAiRealtimeSocket(
  options: OpenAiRealtimeSocketOptions,
): Promise<WebSocket> {
  const model = options.model ?? REALTIME_MODEL;
  const url = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Upgrade: 'websocket',
    },
  });

  const ws = response.webSocket;
  if (!ws) {
    const body = await response.text().catch(() => '');
    const safeBody = options.apiKey
      ? body.split(options.apiKey).join('[redacted]')
      : body;
    throw new Error(
      `OpenAI Realtime WebSocket connection failed: ${response.status} ${safeBody}`,
    );
  }

  ws.accept();
  await waitForEvent(ws, 'session.created');

  return ws;
}

/**
 * Sends `session.update` and waits for `session.updated` before returning —
 * a rejected session config (an unsupported field, a malformed value) must
 * surface as a thrown error here, not as silence followed by dead air on a
 * live call.
 */
export async function updateSession(
  ws: WebSocket,
  session: Record<string, unknown>,
): Promise<void> {
  ws.send(JSON.stringify({ type: 'session.update', session }));
  await waitForEvent(ws, 'session.updated');
}

/**
 * Resolves on the first event of the given `type`, rejects on an `error`
 * event, the socket closing, or a timeout — whichever comes first. Not
 * exported: CallRelay's own long-lived message loop takes over once the
 * initial handshake (session.created, then session.updated) is done, and has
 * no further use for one-shot waiting.
 */
function waitForEvent(ws: WebSocket, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for OpenAI Realtime "${type}" event`));
    }, CONNECT_TIMEOUT_MS);

    function onMessage(event: Event) {
      const data = (event as MessageEvent).data;
      let parsed: { type?: string } | null = null;
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : '') as { type?: string };
      } catch {
        return; // ignore unparseable frames while waiting
      }
      if (parsed.type === type) {
        cleanup();
        resolve();
      } else if (parsed.type === 'error') {
        cleanup();
        reject(new Error(`OpenAI Realtime error while waiting for "${type}": ${data}`));
      }
    }

    function onClose() {
      cleanup();
      reject(new Error(`OpenAI Realtime socket closed while waiting for "${type}"`));
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}
