/**
 * Runtime config.
 *
 * On Workers there is no `process.env` — bindings arrive per-request in `env`.
 * So config is built from that, not read from module scope, and validation
 * happens on the first request rather than at boot.
 */

export interface Env {
  VAPI_API_KEY: string;
  VAPI_WEBHOOK_SECRET: string;
  VAPI_PHONE_NUMBER: string;
  /**
   * Optional. Nothing in this codebase currently reads it — no route, no
   * assistant, no live-call control path — because we never call the Vapi API
   * to look up or manage the number itself, only to speak into a call that's
   * already in progress. Kept available for whenever that changes, but never
   * make it required: the UUID is fiddly to locate in Vapi's dashboard and
   * gating startup on an unused value is a needless deploy blocker.
   */
  VAPI_PHONE_NUMBER_ID?: string;
  PUBLIC_SERVER_URL: string;
  VAPI_BASE_URL?: string;
  DB: D1Database;
}

export interface Config {
  vapi: {
    apiKey: string;
    webhookSecret: string;
    phoneNumber: string;
    phoneNumberId?: string;
    baseUrl: string;
  };
  serverUrl: string;
  webhookUrl: string;
}

const REQUIRED = [
  'VAPI_API_KEY',
  'VAPI_WEBHOOK_SECRET',
  'VAPI_PHONE_NUMBER',
  'PUBLIC_SERVER_URL',
] as const;

/**
 * Report characters in a secret that can't legitimately be there.
 *
 * Every value we take is ASCII by construction: API keys, a phone number, a
 * URL, a shared secret we generate ourselves. So anything outside printable
 * ASCII — or any surrounding whitespace — means the value was mistyped or
 * mangled on its way in, not that it's merely wrong.
 *
 * This exists because the Cloudflare deploy token arrived containing Cyrillic
 * homoglyphs (К А Е у Х е С Т — visually identical to K A E y X e C T), which
 * cost several rounds to find precisely because the value *looked* correct.
 * The same paste can just as easily contaminate the Vapi secrets, where the
 * symptom would be a failed call rather than a failed deploy.
 *
 * Returns a human-readable description of the problem, or null if clean. Never
 * returns the value itself — only the offending characters, which by definition
 * are not part of a valid secret.
 */
function describeContamination(value: string): string | null {
  // Checked before the printable-ASCII filter below, because a bare space
  // (U+0020) IS printable ASCII and would otherwise slide through it. Every
  // value here — a key, a secret, a phone number, a URL — is meant to be one
  // unbroken token, so any whitespace at all is a sign two things got pasted
  // together, not a plain-ASCII value that merely contains a space.
  if (/\s/.test(value)) {
    return value !== value.trim()
      ? 'has leading or trailing whitespace'
      : 'contains embedded whitespace — expected a single unbroken token, ' +
          'so a space usually means two values got pasted together';
  }

  const bad = [...value].filter((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || code > 0x7e;
  });

  if (bad.length === 0) return null;

  const described = [...new Set(bad)]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    .join(', ');

  return (
    `contains ${bad.length} non-ASCII or control character(s): ${described}. ` +
    'Characters like Cyrillic А/Е/С render identically to Latin A/E/C — ' +
    're-copy the value rather than retyping it'
  );
}

export function buildConfig(env: Env): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. ` +
        'Set them with `wrangler secret put <NAME>` or in the Cloudflare ' +
        'dashboard under Workers → Settings → Variables.',
    );
  }

  // Checked whether required or not: an optional value that IS set should
  // still be caught if it's mangled, since it'll be silently wrong later
  // rather than loudly wrong now.
  const toCheck = env.VAPI_PHONE_NUMBER_ID
    ? [...REQUIRED, 'VAPI_PHONE_NUMBER_ID' as const]
    : REQUIRED;

  const contaminated = toCheck
    .map((name) => {
      const problem = describeContamination(env[name]!);
      return problem ? `${name} ${problem}` : null;
    })
    .filter((entry): entry is string => entry !== null);

  if (contaminated.length > 0) {
    throw new Error(`Malformed secret(s): ${contaminated.join('; ')}`);
  }

  const serverUrl = env.PUBLIC_SERVER_URL.replace(/\/+$/, '');

  return {
    vapi: {
      apiKey: env.VAPI_API_KEY,
      webhookSecret: env.VAPI_WEBHOOK_SECRET,
      phoneNumber: env.VAPI_PHONE_NUMBER,
      ...(env.VAPI_PHONE_NUMBER_ID && {
        phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
      }),
      baseUrl: env.VAPI_BASE_URL ?? 'https://api.vapi.ai',
    },
    serverUrl,
    webhookUrl: `${serverUrl}/vapi/webhook`,
  };
}
