/**
 * Runtime config.
 *
 * On Workers there is no `process.env` — bindings arrive per-request in `env`.
 * So config is built from that, not read from module scope, and validation
 * happens on the first request rather than at boot.
 *
 * Two independent feature surfaces share this Worker:
 *
 *   - `vapi`  — the phone-call mode (Vapi + telephony). Paused, not scrapped;
 *     see docs/technical-decisions.md, ADR-005. Its four secrets are either
 *     all present or all absent — there is no partial state.
 *   - `openai` — the in-person mode (direct OpenAI Realtime over WebRTC),
 *     the current primary target. Needs just one secret.
 *
 * Neither gates the other. A deploy with only `OPENAI_API_KEY` set boots
 * fine and serves `/realtime/session`; `/vapi/webhook` independently reports
 * "phone mode not configured" rather than the whole Worker refusing to start.
 * That decoupling is deliberate: it must stay possible to run this Worker
 * with either mode configured alone, or both, or (during setup) neither.
 */

export interface Env {
  // Phone-call mode (Vapi). All four required together, or omit all four.
  VAPI_API_KEY?: string;
  VAPI_WEBHOOK_SECRET?: string;
  VAPI_PHONE_NUMBER?: string;
  PUBLIC_SERVER_URL?: string;
  /**
   * Optional even when the rest of Vapi is configured. Nothing in this
   * codebase reads it — no route, no assistant, no live-call control path —
   * because we never call the Vapi API to look up or manage the number
   * itself, only to speak into a call that's already in progress. The UUID
   * is fiddly to locate in Vapi's dashboard, so it's never worth gating on.
   */
  VAPI_PHONE_NUMBER_ID?: string;
  VAPI_BASE_URL?: string;

  // In-person mode (direct OpenAI Realtime).
  OPENAI_API_KEY?: string;

  DB: D1Database;
}

export interface VapiConfig {
  apiKey: string;
  webhookSecret: string;
  phoneNumber: string;
  phoneNumberId?: string;
  baseUrl: string;
  webhookUrl: string;
}

export interface OpenAiConfig {
  apiKey: string;
}

export interface Config {
  /** Present only when all four Vapi secrets are set. */
  vapi?: VapiConfig;
  /** Present only when OPENAI_API_KEY is set. */
  openai?: OpenAiConfig;
}

/** Every secret name buildConfig knows how to read off Env, for contamination checks. */
const ALL_SECRET_FIELDS = [
  'VAPI_API_KEY',
  'VAPI_WEBHOOK_SECRET',
  'VAPI_PHONE_NUMBER',
  'PUBLIC_SERVER_URL',
  'VAPI_PHONE_NUMBER_ID',
  'VAPI_BASE_URL',
  'OPENAI_API_KEY',
] as const;

/** The four that form phone-call mode — present together, or not at all. */
const VAPI_FIELDS = [
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
 * The same paste can just as easily contaminate any of these secrets, where
 * the symptom would be a silent runtime failure rather than a failed deploy.
 *
 * Returns a human-readable description of the problem, or null if clean. Never
 * returns the value itself — only the offending characters, which by definition
 * are not part of a valid secret.
 */
function describeContamination(value: string): string | null {
  // Checked before the printable-ASCII filter below, because a bare space
  // (U+0020) IS printable ASCII and would otherwise slide through it. Every
  // value here is meant to be one unbroken token, so any whitespace at all is
  // a sign two things got pasted together, not a plain-ASCII value that
  // merely contains a space.
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
  // Checked on every field that's actually set, regardless of which feature
  // it belongs to — an optional value that IS present should still be caught
  // if it's mangled, since otherwise it's silently wrong later instead of
  // loudly wrong now.
  const contaminated = ALL_SECRET_FIELDS.map((name) => {
    const value = env[name];
    if (!value) return null;
    const problem = describeContamination(value);
    return problem ? `${name} ${problem}` : null;
  }).filter((entry): entry is string => entry !== null);

  if (contaminated.length > 0) {
    throw new Error(`Malformed secret(s): ${contaminated.join('; ')}`);
  }

  const config: Config = {};

  const vapiPresent = VAPI_FIELDS.filter((name) => env[name]);
  if (vapiPresent.length === VAPI_FIELDS.length) {
    const serverUrl = env.PUBLIC_SERVER_URL!.replace(/\/+$/, '');
    config.vapi = {
      apiKey: env.VAPI_API_KEY!,
      webhookSecret: env.VAPI_WEBHOOK_SECRET!,
      phoneNumber: env.VAPI_PHONE_NUMBER!,
      ...(env.VAPI_PHONE_NUMBER_ID && {
        phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
      }),
      baseUrl: env.VAPI_BASE_URL ?? 'https://api.vapi.ai',
      webhookUrl: `${serverUrl}/vapi/webhook`,
    };
  } else if (vapiPresent.length > 0) {
    // Some but not all four — almost certainly a mistake (e.g. one secret
    // never got added, or was deleted while rotating), not an intentional
    // "half-configured" state. Fail loudly rather than silently treating
    // phone mode as unconfigured when someone thought they'd set it up.
    const missing = VAPI_FIELDS.filter((name) => !env[name]);
    throw new Error(
      `Phone-call mode is partially configured: missing ${missing.join(', ')}. ` +
        'Set all four Vapi secrets to enable phone mode, or none to leave it ' +
        'disabled — see docs/SETUP.md.',
    );
  }
  // vapiPresent.length === 0: phone mode simply isn't configured. Not an
  // error — it's paused, and a fresh in-person-only deploy shouldn't need it.

  if (env.OPENAI_API_KEY) {
    config.openai = { apiKey: env.OPENAI_API_KEY };
  }

  return config;
}
