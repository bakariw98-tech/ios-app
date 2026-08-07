/**
 * lib/twilio.ts tests.
 *
 * Signature verification is checked against Twilio's own published worked
 * example (https://www.twilio.com/docs/usage/security), not a self-derived
 * vector — the one place in this file where "our implementation agrees with
 * itself" would not be enough evidence.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildHangupTwiml,
  buildRejectTwiml,
  buildStreamTwiml,
  computeTwilioSignature,
  endCall,
  escapeXml,
  signStreamToken,
  verifyStreamToken,
  verifyTwilioSignature,
} from '../src/lib/twilio.js';

describe('computeTwilioSignature / verifyTwilioSignature', () => {
  // Twilio's own worked example, reproduced exactly from their docs:
  // URL, five POST params, Auth Token "12345", expected signature
  // "L/OH5YylLD5NRKLltdqwSvS0BnU=".
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  const authToken = '12345';
  const params = {
    Digits: '1234',
    To: '+18005551212',
    From: '+14158675310',
    Caller: '+14158675310',
    CallSid: 'CA1234567890ABCDE',
  };
  const expectedSignature = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';

  it('reproduces Twilio\'s own published test vector', async () => {
    const signature = await computeTwilioSignature(authToken, url, params);
    expect(signature).toBe(expectedSignature);
  });

  it('verifies a signature computed with the correct auth token', async () => {
    expect(await verifyTwilioSignature(authToken, url, params, expectedSignature)).toBe(
      true,
    );
  });

  it('rejects the correct signature under the wrong auth token', async () => {
    expect(await verifyTwilioSignature('wrong-token', url, params, expectedSignature)).toBe(
      false,
    );
  });

  it('rejects a mismatched URL (classic proxy/Host-mismatch failure mode)', async () => {
    expect(
      await verifyTwilioSignature(authToken, 'https://example.com/other', params, expectedSignature),
    ).toBe(false);
  });

  it('rejects a tampered parameter', async () => {
    expect(
      await verifyTwilioSignature(authToken, url, { ...params, Digits: '9999' }, expectedSignature),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length outright', async () => {
    expect(await verifyTwilioSignature(authToken, url, params, 'short')).toBe(false);
  });

  it('is order-independent — params object key order does not change the result', async () => {
    const reordered = {
      CallSid: params.CallSid,
      Caller: params.Caller,
      Digits: params.Digits,
      From: params.From,
      To: params.To,
    };
    const signature = await computeTwilioSignature(authToken, url, reordered);
    expect(signature).toBe(expectedSignature);
  });
});

describe('signStreamToken / verifyStreamToken', () => {
  it('verifies a token minted for the same call and auth token', async () => {
    const token = await signStreamToken('authtok', 'CA123');
    expect(await verifyStreamToken('authtok', 'CA123', token)).toBe(true);
  });

  it('rejects a token minted for a different call', async () => {
    const token = await signStreamToken('authtok', 'CA123');
    expect(await verifyStreamToken('authtok', 'CA999', token)).toBe(false);
  });

  it('rejects a token minted under a different auth token', async () => {
    const token = await signStreamToken('authtok', 'CA123');
    expect(await verifyStreamToken('other-token', 'CA123', token)).toBe(false);
  });

  it('never collides with an ordinary Twilio request signature for the same auth token and callSid-shaped URL', async () => {
    // Defense in depth: the `stream:` prefix means the signed string can
    // never coincide with what verifyTwilioSignature would compute for any
    // real request URL, even one that happens to be exactly "CA123".
    const streamToken = await signStreamToken('authtok', 'CA123');
    const requestSignature = await computeTwilioSignature('authtok', 'CA123', {});
    expect(streamToken).not.toBe(requestSignature);
  });
});

describe('escapeXml', () => {
  it('escapes all five XML special characters', () => {
    expect(escapeXml(`<a> & "b" 'c'`)).toBe('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
});

describe('buildStreamTwiml', () => {
  it('produces a Connect/Stream verb with the given URL', () => {
    const twiml = buildStreamTwiml('wss://example.workers.dev/twilio/stream/tok123');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain(
      '<Stream url="wss://example.workers.dev/twilio/stream/tok123" />',
    );
    expect(twiml).toContain('</Connect>');
  });

  it('escapes the URL in case it ever contains XML-significant characters', () => {
    const twiml = buildStreamTwiml('wss://example.test/stream/a&b');
    expect(twiml).toContain('a&amp;b');
    expect(twiml).not.toContain('a&b"');
  });

  it('is well-formed enough to contain exactly one Response root', () => {
    const twiml = buildStreamTwiml('wss://example.test/stream/tok');
    expect(twiml.match(/<Response>/g)).toHaveLength(1);
    expect(twiml.match(/<\/Response>/g)).toHaveLength(1);
  });
});

describe('buildHangupTwiml', () => {
  it('speaks the given message then hangs up', () => {
    const twiml = buildHangupTwiml('Sorry, this line is not available right now.');
    expect(twiml).toContain('<Say>Sorry, this line is not available right now.</Say>');
    expect(twiml).toContain('<Hangup />');
  });

  it('escapes message text', () => {
    const twiml = buildHangupTwiml(`Tom & Jerry's "show"`);
    expect(twiml).toContain('Tom &amp; Jerry&apos;s &quot;show&quot;');
  });
});

describe('buildRejectTwiml', () => {
  it('produces a bare Reject verb, no Say', () => {
    const twiml = buildRejectTwiml();
    expect(twiml).toContain('<Reject />');
    expect(twiml).not.toContain('<Say>');
  });
});

describe('endCall', () => {
  it('POSTs Status=completed to the correct Calls endpoint with Basic auth', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });

    await endCall('ACxxx', 'authtok', 'CAyyy');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls/CAyyy.json',
    );
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(calls[0]!.init.body).toBe('Status=completed');

    vi.unstubAllGlobals();
  });

  it('throws with the status and a redacted body on failure', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('bad auth token authtok here', { status: 401 }),
    );

    await expect(endCall('ACxxx', 'authtok', 'CAyyy')).rejects.toThrow(/401/);
    await expect(endCall('ACxxx', 'authtok', 'CAyyy')).rejects.not.toThrow(/authtok here/);

    vi.unstubAllGlobals();
  });
});
