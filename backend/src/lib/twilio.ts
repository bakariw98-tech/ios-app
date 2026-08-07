/**
 * Twilio client — the narrow slice we actually use.
 *
 * Note what is deliberately absent, and why it matters more here than it did
 * for lib/vapi.ts's equivalent warning: there is no `createOutboundCall` and
 * no participant/conference helper. Unlike Vapi (which never offered a
 * server-initiated outbound-dial primitive at all — ADR-001 designed around
 * that gap), Twilio genuinely *can* dial the recipient with one HTTP call:
 *
 *   POST /2010-04-01/Accounts/{Sid}/Conferences/{Sid}/Participants.json
 *
 * Using that on the recipient's leg would violate N4 (docs/compliance.md):
 * our verbal consent only happens after the recipient has already answered a
 * call *the user* placed, so any path where our own infrastructure dials
 * them breaks the TCPA "consent prior to the call" requirement outright,
 * regardless of which vendor makes the request. The user must still tap Add
 * Call, dial the recipient, and tap Merge Calls themselves — every time, no
 * exceptions, no matter how easy Twilio makes the shortcut. If you are
 * reading this because you're about to add a function that calls the
 * Participants API or `POST /Calls.json` with a `To` aimed at anyone but our
 * own number: don't. See ADR-006 ("Twilio can dial the recipient. We will
 * never use that.") and test/noOutboundDialing.test.ts, which greps this
 * repo for exactly these endpoint strings and fails the build if they show
 * up anywhere outside this comment.
 *
 * What IS here: signature verification (so we know a request genuinely came
 * from Twilio), TwiML generation (so we can tell Twilio what to do with a
 * call already in progress), and ending a call we're already on. All three
 * operate on a call that already exists — none of them can originate one.
 */

import { base64Encode } from './audio.js';

/**
 * Verify Twilio's request/WebSocket-upgrade signature.
 *
 * Implements Twilio's documented algorithm exactly (confirmed against
 * Twilio's own docs, https://www.twilio.com/docs/usage/security):
 *
 *   1. Take the full request URL, protocol through the end of the query
 *      string.
 *   2. Sort the POST params alphabetically, Unix-style case-sensitive order
 *      (plain `Array.prototype.sort()` on a JS string array already does
 *      this for the ASCII field names Twilio sends).
 *   3. Append each param's name then its value (no delimiters) to the URL
 *      string, in that sorted order.
 *   4. HMAC-SHA1 the result, keyed with the account's Auth Token.
 *   5. Base64-encode the digest and compare to `X-Twilio-Signature`.
 *
 * Cross-checked against Twilio's own worked example in the docs (URL
 * `https://example.com/myapp.php?foo=1&bar=2`, five named POST params, Auth
 * Token `12345`, expected signature `L/OH5YylLD5NRKLltdqwSvS0BnU=`) — see
 * test/twilio.test.ts, which reproduces that exact vector.
 *
 * Twilio explicitly recommends using their own SDK's validator rather than a
 * hand-rolled one; there is no published Twilio SDK subset confirmed to run
 * under Cloudflare Workers' `nodejs_compat`; this reimplements the algorithm
 * from the documented steps and pins it against Twilio's own published
 * vector rather than trusting a from-scratch derivation alone.
 *
 * Constant-time compare against `providedSignature`, same reasoning as
 * routes/webhook.ts's Vapi secret check — this decides whether a request
 * gets treated as genuinely from Twilio.
 */
export async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  providedSignature: string,
): Promise<boolean> {
  const expected = await computeTwilioSignature(authToken, url, params);
  return secretsMatch(expected, providedSignature);
}

/** The signing half of verifyTwilioSignature — exported for tests and for minting per-call signed tokens. */
export async function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64Encode(new Uint8Array(digest));
}

/**
 * Constant-time string comparison. Duplicated from routes/webhook.ts rather
 * than imported: that file is route-layer (Hono-specific error handling
 * around it), this is lib-layer with no such dependency, and the function
 * itself is three lines with no state — cheaper to keep two copies in sync
 * by inspection than to introduce a routes→lib import in the wrong
 * direction, or a new shared file for one three-line helper.
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
 * Mint a short-lived per-call path token binding a Media Stream WebSocket
 * connection to one specific CallSid.
 *
 * `<Stream url>` can't carry query parameters, so the token has to live in a
 * path segment (`/twilio/stream/:callSid/:token`) — and the static
 * `X-Twilio-Signature` header on the WS upgrade alone can't do this binding:
 * it proves the request came from Twilio, but not that it's for *this*
 * call specifically. This reuses the same HMAC-SHA1-over-Auth-Token
 * machinery as verifyTwilioSignature, with a distinct `stream:` prefix so a
 * minted token can never collide with an actual Twilio request signature for
 * the same Auth Token, even in principle.
 */
export async function signStreamToken(authToken: string, callSid: string): Promise<string> {
  return computeTwilioSignature(authToken, `stream:${callSid}`, {});
}

/** Verify a token minted by signStreamToken, constant-time. */
export async function verifyStreamToken(
  authToken: string,
  callSid: string,
  providedToken: string,
): Promise<boolean> {
  const expected = await signStreamToken(authToken, callSid);
  return secretsMatch(expected, providedToken);
}

/** Escape text for safe embedding inside XML element content or an attribute value. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * TwiML telling Twilio to open a bidirectional Media Stream and hand the
 * call over to it. `<Connect><Stream>` blocks all further TwiML until the
 * WebSocket server closes the connection (confirmed from Twilio's docs) —
 * this is the only verb routes/twilio.ts's voice webhook needs to return
 * for a configured call.
 *
 * Takes the full stream URL as a string, already including its per-call
 * token path segment — minting that token is routes/twilio.ts's job (it
 * needs request-scoped signing state this file has no reason to hold), not
 * this function's. `<Stream url>` takes a `wss://` URL and cannot carry
 * query parameters, which is exactly why the token lives in a path segment.
 */
export function buildStreamTwiml(streamUrl: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Response>' +
    '<Connect>' +
    `<Stream url="${escapeXml(streamUrl)}" />` +
    '</Connect>' +
    '</Response>'
  );
}

/** TwiML that speaks a message, then hangs up. Used for the "not configured" / graceful-failure path. */
export function buildHangupTwiml(message: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Response>' +
    `<Say>${escapeXml(message)}</Say>` +
    '<Hangup />' +
    '</Response>'
  );
}

/**
 * TwiML that rejects the call before it's answered — no audio, no charge.
 * For requests that fail signature verification: a request that isn't
 * genuinely from Twilio gets no information about why, just silence.
 */
export function buildRejectTwiml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' + '<Response>' + '<Reject />' + '</Response>'
  );
}

/**
 * End a call already in progress. The one piece of live call control this
 * file exposes — same shape as lib/vapi.ts's `say()`/`endCall()`, and
 * exactly as narrow: it operates on a CallSid we already hold because we're
 * already on that call, never on a number we look up or dial ourselves.
 */
export async function endCall(
  accountSid: string,
  authToken: string,
  callSid: string,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
  const auth = base64Encode(new TextEncoder().encode(`${accountSid}:${authToken}`));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Status: 'completed' }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Same redaction discipline as lib/openaiChat.ts's error path: never let
    // a credential that happens to appear in an error body reach a log.
    const safeBody = authToken ? body.split(authToken).join('[redacted]') : body;
    throw new Error(`Twilio POST /Calls/${callSid}.json failed: ${response.status} ${safeBody}`);
  }
}
