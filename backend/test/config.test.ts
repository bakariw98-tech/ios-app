/**
 * Secret validation and mode decoupling.
 *
 * Two things this file protects:
 *
 * 1. Contamination checking. Motivated by a real incident: the Cloudflare
 *    deploy token arrived containing Cyrillic homoglyphs, which took several
 *    rounds to spot because the value looked correct on screen. The same
 *    mistake in a secret here would surface as a silent runtime failure, so
 *    it's worth catching at config time with a message that names the
 *    problem.
 *
 * 2. Mode decoupling (ADR-005). Phone-call mode (Vapi) is paused; in-person
 *    mode (direct OpenAI Realtime) is the current primary target. Neither
 *    should gate the other — a deploy with only OPENAI_API_KEY set must boot
 *    cleanly, and a deploy with only Vapi secrets set (for anyone still
 *    running phone mode) must boot without OPENAI_API_KEY.
 */

import { describe, expect, it } from 'vitest';

import { type Env, buildConfig } from '../src/lib/config.js';

const vapiOnly: Env = {
  VAPI_API_KEY: 'abc123def456',
  VAPI_WEBHOOK_SECRET: 'a-long-random-secret',
  VAPI_PHONE_NUMBER: '+15551234567',
  VAPI_PHONE_NUMBER_ID: '11111111-2222-3333-4444-555555555555',
  PUBLIC_SERVER_URL: 'https://example.workers.dev',
  DB: {} as never, CALL_RELAY: {} as never,
};

const twilioOnly: Env = {
  TWILIO_ACCOUNT_SID: 'ACabc123def456abc123def456abc1234',
  TWILIO_AUTH_TOKEN: 'a-long-random-auth-token',
  TWILIO_PHONE_NUMBER: '+15559876543',
  PUBLIC_SERVER_URL: 'https://example.workers.dev',
  DB: {} as never, CALL_RELAY: {} as never,
};

const openaiOnly: Env = {
  OPENAI_API_KEY: 'sk-test-abc123',
  DB: {} as never, CALL_RELAY: {} as never,
};

describe('mode decoupling', () => {
  it('boots with neither mode configured', () => {
    const config = buildConfig({ DB: {} as never, CALL_RELAY: {} as never });
    expect(config.vapi).toBeUndefined();
    expect(config.openai).toBeUndefined();
  });

  it('configures only in-person mode when just OPENAI_API_KEY is set', () => {
    const config = buildConfig(openaiOnly);
    expect(config.openai).toEqual({ apiKey: 'sk-test-abc123' });
    expect(config.vapi).toBeUndefined();
  });

  it('configures only phone mode when just the Vapi secrets are set', () => {
    const config = buildConfig(vapiOnly);
    expect(config.vapi).toBeDefined();
    expect(config.openai).toBeUndefined();
  });

  it('configures both when both are set', () => {
    const config = buildConfig({ ...vapiOnly, ...openaiOnly });
    expect(config.vapi).toBeDefined();
    expect(config.openai).toBeDefined();
  });

  it('rejects a partial Vapi configuration rather than silently disabling it', () => {
    // Missing PUBLIC_SERVER_URL only — the other three Vapi secrets are set,
    // which is very unlikely to be intentional (more likely: one secret
    // never got added, or was deleted while rotating something else).
    const { PUBLIC_SERVER_URL: _drop, ...partial } = vapiOnly;
    expect(() => buildConfig(partial)).toThrow(
      /partially configured: missing PUBLIC_SERVER_URL/,
    );
  });

  it('names every missing field in a partial Vapi configuration', () => {
    const { VAPI_API_KEY: _a, VAPI_WEBHOOK_SECRET: _b, ...partial } = vapiOnly;
    expect(() => buildConfig(partial)).toThrow(
      /VAPI_API_KEY, VAPI_WEBHOOK_SECRET/,
    );
  });

  it('configures only Twilio phone mode when just the Twilio secrets are set', () => {
    const config = buildConfig(twilioOnly);
    expect(config.twilio).toBeDefined();
    expect(config.vapi).toBeUndefined();
    expect(config.openai).toBeUndefined();
  });

  it('configures Vapi, Twilio, and OpenAI simultaneously when all are set', () => {
    const config = buildConfig({ ...vapiOnly, ...twilioOnly, ...openaiOnly });
    expect(config.vapi).toBeDefined();
    expect(config.twilio).toBeDefined();
    expect(config.openai).toBeDefined();
  });

  it('rejects a partial Twilio configuration rather than silently disabling it', () => {
    const { PUBLIC_SERVER_URL: _drop, ...partial } = twilioOnly;
    expect(() => buildConfig(partial)).toThrow(
      /Twilio phone-call mode is partially configured: missing PUBLIC_SERVER_URL/,
    );
  });

  it('names every missing field in a partial Twilio configuration', () => {
    const {
      TWILIO_ACCOUNT_SID: _a,
      TWILIO_AUTH_TOKEN: _b,
      ...partial
    } = twilioOnly;
    expect(() => buildConfig(partial)).toThrow(
      /TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN/,
    );
  });
});

describe('Twilio config shape', () => {
  it('builds the webhook and stream URLs from PUBLIC_SERVER_URL', () => {
    const config = buildConfig(twilioOnly);
    expect(config.twilio?.phoneNumber).toBe('+15559876543');
    expect(config.twilio?.serverUrl).toBe('https://example.workers.dev');
    expect(config.twilio?.voiceWebhookUrl).toBe(
      'https://example.workers.dev/twilio/voice',
    );
    expect(config.twilio?.statusWebhookUrl).toBe(
      'https://example.workers.dev/twilio/status',
    );
    expect(config.twilio?.streamUrlBase).toBe(
      'wss://example.workers.dev/twilio/stream',
    );
  });

  it('strips a trailing slash from the server URL before building URLs', () => {
    const config = buildConfig({
      ...twilioOnly,
      PUBLIC_SERVER_URL: 'https://example.workers.dev///',
    });
    expect(config.twilio?.voiceWebhookUrl).toBe(
      'https://example.workers.dev/twilio/voice',
    );
    expect(config.twilio?.streamUrlBase).toBe(
      'wss://example.workers.dev/twilio/stream',
    );
  });

  it('validates Twilio secrets for contamination the same way as Vapi', () => {
    expect(() =>
      buildConfig({ ...twilioOnly, TWILIO_AUTH_TOKEN: 'token ' }),
    ).toThrow(/TWILIO_AUTH_TOKEN has leading or trailing whitespace/);
  });
});

describe('shared PUBLIC_SERVER_URL does not cross-trip the other mode\'s partial check', () => {
  // Regression coverage for a real bug caught while wiring up Twilio: since
  // PUBLIC_SERVER_URL is one of Vapi's four fields AND one of Twilio's four
  // fields, a Vapi-only deploy sets it too — and a naive "some but not all
  // of this group's fields are present" check would misread that as a
  // half-configured Twilio setup (and vice versa for a Twilio-only deploy).

  it('a Vapi-only deploy does not throw a Twilio partial-config error', () => {
    expect(() => buildConfig(vapiOnly)).not.toThrow();
    const config = buildConfig(vapiOnly);
    expect(config.twilio).toBeUndefined();
  });

  it('a Twilio-only deploy does not throw a Vapi partial-config error', () => {
    expect(() => buildConfig(twilioOnly)).not.toThrow();
    const config = buildConfig(twilioOnly);
    expect(config.vapi).toBeUndefined();
  });
});

describe('Vapi config shape', () => {
  it('builds vapi.webhookUrl from PUBLIC_SERVER_URL', () => {
    const config = buildConfig(vapiOnly);
    expect(config.vapi?.phoneNumber).toBe('+15551234567');
    expect(config.vapi?.webhookUrl).toBe(
      'https://example.workers.dev/vapi/webhook',
    );
  });

  it('strips a trailing slash from the server URL before building webhookUrl', () => {
    const config = buildConfig({
      ...vapiOnly,
      PUBLIC_SERVER_URL: 'https://example.workers.dev///',
    });
    expect(config.vapi?.webhookUrl).toBe(
      'https://example.workers.dev/vapi/webhook',
    );
  });

  it('does not require VAPI_PHONE_NUMBER_ID', () => {
    // Nothing in the codebase reads this value, and it's fiddly to locate in
    // Vapi's dashboard — gating on it is a pointless deploy blocker.
    const { VAPI_PHONE_NUMBER_ID: _unused, ...withoutId } = vapiOnly;
    const config = buildConfig(withoutId);
    expect(config.vapi?.phoneNumberId).toBeUndefined();
  });

  it('still validates VAPI_PHONE_NUMBER_ID for contamination when present', () => {
    // Optional does not mean unchecked — a mangled value that IS supplied
    // should fail loudly now, not silently later.
    expect(() =>
      buildConfig({ ...vapiOnly, VAPI_PHONE_NUMBER_ID: '111 222' }),
    ).toThrow(/VAPI_PHONE_NUMBER_ID contains embedded whitespace/);
  });
});

describe('malformed secrets', () => {
  it('rejects Cyrillic homoglyphs and names the codepoints', () => {
    // "аbc123def456" — the first character is CYRILLIC SMALL A (U+0430),
    // not Latin 'a'. Visually identical.
    const error = (() => {
      try {
        buildConfig({ ...vapiOnly, VAPI_API_KEY: 'аbc123def456' });
      } catch (e) {
        return (e as Error).message;
      }
    })();

    expect(error).toMatch(/VAPI_API_KEY/);
    expect(error).toMatch(/U\+0430/);
    expect(error).toMatch(/render identically/);
  });

  it('rejects leading or trailing whitespace', () => {
    expect(() =>
      buildConfig({ ...vapiOnly, VAPI_WEBHOOK_SECRET: 'secret-value ' }),
    ).toThrow(/VAPI_WEBHOOK_SECRET has leading or trailing whitespace/);
  });

  it('rejects an embedded control character', () => {
    // Written as an escape rather than a literal byte, so the invisible
    // character in this test is visible in the source instead of silently
    // sitting in the file -- which is exactly the class of bug this check
    // exists to catch.
    expect(() =>
      buildConfig({ ...vapiOnly, VAPI_PHONE_NUMBER_ID: 'abc\x00def' }),
    ).toThrow(/VAPI_PHONE_NUMBER_ID contains/);
  });

  it('rejects embedded whitespace even though a bare space is printable ASCII', () => {
    // The gap this closes: a literal space (U+0020) is ordinary printable
    // ASCII, so a filter that only excludes control characters and
    // non-ASCII bytes never sees it. Two concatenated values, or a
    // copy-paste that grabbed a label ("Token: abc123"), both produce this
    // shape, and both are real mistakes worth catching.
    expect(() =>
      buildConfig({ ...vapiOnly, VAPI_API_KEY: 'abc 123' }),
    ).toThrow(/VAPI_API_KEY contains embedded whitespace/);
  });

  it('validates OPENAI_API_KEY the same way as every other secret', () => {
    expect(() =>
      buildConfig({ ...openaiOnly, OPENAI_API_KEY: 'sk-test ' }),
    ).toThrow(/OPENAI_API_KEY has leading or trailing whitespace/);
  });

  it('reports every contaminated secret, not just the first', () => {
    const error = (() => {
      try {
        buildConfig({
          ...vapiOnly,
          VAPI_API_KEY: 'аbc',
          VAPI_PHONE_NUMBER: '+1555Е0000',
        });
      } catch (e) {
        return (e as Error).message;
      }
    })();

    expect(error).toMatch(/VAPI_API_KEY/);
    expect(error).toMatch(/VAPI_PHONE_NUMBER/);
  });

  it('never echoes the secret value itself', () => {
    const error = (() => {
      try {
        buildConfig({ ...vapiOnly, VAPI_API_KEY: 'аsuper-secret-value' });
      } catch (e) {
        return (e as Error).message;
      }
    })();

    expect(error).not.toMatch(/super-secret-value/);
  });

  it('accepts ordinary ASCII punctuation that legitimately appears in secrets', () => {
    expect(() =>
      buildConfig({
        ...vapiOnly,
        VAPI_WEBHOOK_SECRET: 'aB3_-.~+/=:@!#$%^&*()[]{}|<>?,;"\'`',
      }),
    ).not.toThrow();
  });
});
