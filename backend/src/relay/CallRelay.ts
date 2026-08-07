/**
 * CallRelay — the Durable Object bridging one live Twilio Media Stream
 * WebSocket to one OpenAI Realtime WebSocket.
 *
 * Phase 2 skeleton only, per the approved Twilio migration plan
 * (docs/technical-decisions.md, ADR-006): the interview persona only, audio
 * bridged both directions, barge-in handled. No tools, no CallPhase/D1
 * lifecycle, no handoff, no disclosure. Compliance-critical logic (the
 * merge-window tripwires, the two-socket handoff, the disclosure) is Phase
 * 4/5 and is NOT implemented here — this object is not yet safe to use for
 * a real conversation with a real recipient on the line, only for verifying
 * the socket plumbing itself with the interview assistant.
 *
 * One instance per call, addressed by Twilio CallSid
 * (`env.CALL_RELAY.idFromName(callSid)` in routes/twilio.ts). Durable
 * Objects serialize execution per instance — a structural guarantee, not
 * merely usually-true, that events for the same call are never handled
 * concurrently no matter how Cloudflare's edge routes requests to it. That
 * property is *why* this is a Durable Object rather than a plain Worker
 * holding a socket — see the migration plan's "Justification" section.
 */

import { buildConfig, type Env } from '../lib/config.js';
import { openOpenAiRealtimeSocket, updateSession } from '../lib/openaiRealtimeSocket.js';
import { INTERVIEW_PROMPT_SKELETON } from './interviewPromptSkeleton.js';

interface TwilioStreamEvent {
  event: string;
  streamSid?: string;
  start?: { streamSid?: string; callSid?: string };
  media?: { payload?: string };
}

interface OpenAiRealtimeEvent {
  type: string;
  delta?: string;
  error?: { message?: string };
}

export class CallRelay {
  private env: Env;
  private twilioSocket: WebSocket | null = null;
  private openaiSocket: WebSocket | null = null;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private shuttingDown = false;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    let config;
    try {
      config = buildConfig(this.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`server misconfigured: ${message}`, { status: 500 });
    }
    if (!config.openai) {
      return new Response('openai not configured', { status: 500 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    this.twilioSocket = server;

    server.addEventListener('message', (event) => {
      this.onTwilioMessage(event as MessageEvent).catch((error) => {
        console.error('CallRelay: error handling Twilio message', error);
      });
    });
    server.addEventListener('close', () => this.shutdown('twilio socket closed'));
    server.addEventListener('error', () => this.shutdown('twilio socket error'));

    // Don't block the 101 response on the OpenAI handshake — Twilio's own
    // connection timeout applies to the upgrade itself, not to what happens
    // after. If the OpenAI connection fails, the caller hears silence and
    // this logs loudly rather than the upgrade itself hanging.
    const openaiApiKey = config.openai.apiKey;
    this.connectToOpenAi(openaiApiKey).catch((error) => {
      console.error('CallRelay: failed to open OpenAI Realtime socket', error);
      this.shutdown('openai connect failed');
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async connectToOpenAi(apiKey: string): Promise<void> {
    const socket = await openOpenAiRealtimeSocket({ apiKey });
    this.openaiSocket = socket;

    await updateSession(socket, {
      type: 'realtime',
      instructions: INTERVIEW_PROMPT_SKELETON,
      output_modalities: ['audio'],
      audio: {
        input: {
          // Confirmed live (Phase 0 of the Twilio migration): audio/pcmu
          // needs no `rate` field, unlike audio/pcm's required rate: 24000.
          // Twilio Media Streams is also μ-law 8kHz, so this is a base64
          // passthrough with no transcoding on the hot path.
          format: { type: 'audio/pcmu' },
          turn_detection: {
            type: 'semantic_vad',
            // The user interrupting mid-sentence is normal conversation, not
            // an error — the model must yield immediately.
            interrupt_response: true,
            create_response: true,
          },
        },
        output: { format: { type: 'audio/pcmu' }, voice: 'cedar' },
      },
    });

    socket.addEventListener('message', (event) => {
      this.onOpenAiMessage(event as MessageEvent);
    });
    socket.addEventListener('close', () => this.shutdown('openai socket closed'));
    socket.addEventListener('error', () => this.shutdown('openai socket error'));

    // The assistant speaks first — same shape as the retired Vapi assistants'
    // `firstMessageMode: 'assistant-speaks-first'` (assistants/shared.ts). A
    // caller who connects and hears nothing until they happen to speak first
    // reads as broken, and it also gives e2e/twilio-relay.mjs a real audio
    // round-trip to verify without needing live human speech as input.
    socket.send(JSON.stringify({ type: 'response.create' }));
  }

  private async onTwilioMessage(event: MessageEvent): Promise<void> {
    const data = event.data;
    if (typeof data !== 'string') return;

    let parsed: TwilioStreamEvent;
    try {
      parsed = JSON.parse(data) as TwilioStreamEvent;
    } catch {
      console.error('CallRelay: unparseable Twilio Media Stream message');
      return;
    }

    switch (parsed.event) {
      case 'start':
        this.streamSid = parsed.start?.streamSid ?? null;
        this.callSid = parsed.start?.callSid ?? null;
        break;

      case 'media': {
        const payload = parsed.media?.payload;
        if (!payload || !this.openaiSocket) return;
        // Base64 passthrough — Twilio and OpenAI's audio/pcmu are the same
        // wire format (μ-law, 8kHz), so no decode/re-encode happens here.
        this.openaiSocket.send(
          JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }),
        );
        break;
      }

      case 'stop':
        this.shutdown('twilio sent stop');
        break;

      default:
        // 'connected', 'mark', 'dtmf' — nothing to do with them yet at this phase.
        break;
    }
  }

  private onOpenAiMessage(event: MessageEvent): void {
    const data = event.data;
    if (typeof data !== 'string') return;

    let parsed: OpenAiRealtimeEvent;
    try {
      parsed = JSON.parse(data) as OpenAiRealtimeEvent;
    } catch {
      console.error('CallRelay: unparseable OpenAI Realtime message');
      return;
    }

    switch (parsed.type) {
      case 'response.output_audio.delta':
        // Confirmed live (Phase 2 verification) — NOT 'response.audio.delta',
        // which is what OpenAI's own docs summary claimed when checked the
        // same session; the live event stream disagreed with the docs.
        if (parsed.delta && this.twilioSocket && this.streamSid) {
          this.twilioSocket.send(
            JSON.stringify({
              event: 'media',
              streamSid: this.streamSid,
              media: { payload: parsed.delta },
            }),
          );
        }
        break;

      case 'input_audio_buffer.speech_started':
        // Barge-in: without telling Twilio to drop already-buffered audio,
        // the assistant keeps talking for seconds after being interrupted —
        // the single most common "sounds broken" bug in a bridge like this.
        if (this.twilioSocket && this.streamSid) {
          this.twilioSocket.send(
            JSON.stringify({ event: 'clear', streamSid: this.streamSid }),
          );
        }
        break;

      case 'error':
        // Logged loudly and unconditionally — the direct fix for the
        // silent-failure pattern that broke phone mode twice on the Vapi
        // path (assistants/shared.ts's REALTIME_MODEL doc comment).
        console.error('CallRelay: OpenAI Realtime error', parsed.error?.message ?? parsed);
        break;

      default:
        break;
    }
  }

  private shutdown(reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log(`CallRelay: shutting down (${reason})`, { callSid: this.callSid });
    try {
      this.twilioSocket?.close();
    } catch {
      // already closed
    }
    try {
      this.openaiSocket?.close();
    } catch {
      // already closed
    }
  }
}
