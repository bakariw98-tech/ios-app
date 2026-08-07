/**
 * Runtime config.
 *
 * On Workers there is no `process.env` — bindings arrive per-request in `env`.
 * So config is built from that, not read from module scope, and validation
 * happens on the first request rather than at boot.
 *
 * Three independent feature surfaces share this Worker:
 *
 *   - `vapi`  — phone-call mode's OLD backend (Vapi + telephony). Dormant
 *     during the Twilio migration (docs/technical-decisions.md, ADR-006) —
 *     kept alive only as a fallback while the Twilio path is unproven, not
 *     because both are meant to serve real calls at once. See the note on
 *     `Config.twilio` below for why that distinction matters.
 *   - `twilio` — phone-call mode's NEW backend (Twilio Voice + Media Streams
 *     + a direct OpenAI Realtime bridge). Also needs `openai` set — unlike
 *     Vapi, which held its own OpenAI relationship, this mode calls OpenAI
 *     directly and so depends on both blocks being present.
 *   - `openai` — in-person mode (direct OpenAI Realtime over WebRTC), the
 *     primary target, AND now also a dependency of `twilio`. Needs just one
 *     secret.
 *
 * None of the three gates the others outright — `Config` keeps `vapi`,
 * `twilio`, and `openai` as three independent optional blocks, not a
 * combined `config.phone`. That matches how every call site already checks
 * (`config.vapi ? ... : ...`, `config.openai && ...`): callers on the Twilio
 * path check `config.twilio && config.openai` explicitly rather than relying
 * on a derived "phone mode ready" flag this file would have to keep in sync.
 * `twilio` alone isn't sufficient to serve a call — a route that needs both
 * and gets only one should say so by name in its own error, not bury it in a
 * shared boolean. A deploy with only `OPENAI_API_KEY` set boots fine and
 * serves `/realtime/session`; routes for an unconfigured mode independently
 * report "not configured" rather than the whole Worker refusing to start.
 * That decoupling is deliberate: it must stay possible to run this Worker
 * with any subset of these configured, or none (during setup).
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

  // Phone-call mode (Twilio), the new backend. All four required together,
  // or omit all four. PUBLIC_SERVER_URL is shared with the Vapi block above
  // — both are "where does Twilio/Vapi call us back," same value either way.
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;

  // In-person mode (direct OpenAI Realtime). Also a dependency of Twilio
  // phone mode — see the file-level doc comment above.
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

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  /** `PUBLIC_SERVER_URL`, trailing slashes stripped. */
  serverUrl: string;
  /** Where Twilio's incoming-call webhook should point. */
  voiceWebhookUrl: string;
  /** Where Twilio's call-status callback should point. */
  statusWebhookUrl: string;
  /**
   * Base for the Media Streams WebSocket URL — `wss://…/twilio/stream`, no
   * trailing slash. `<Stream url>` takes a `wss://` URL, not `https://`, and
   * can't carry query params, so routes/twilio.ts appends a path segment
   * (`/:token`), not a query string, when building the full URL per call.
   */
  streamUrlBase: string;
}

export interface Config {
  /** Present only when all four Vapi secrets are set. */
  vapi?: VapiConfig;
  /** Present only when all four Twilio secrets are set. */
  twilio?: TwilioConfig;
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
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'OPENAI_API_KEY',
] as const;

/** The four that form Vapi phone-call mode — present together, or not at all. */
const VAPI_FIELDS = [
  'VAPI_API_KEY',
  'VAPI_WEBHOOK_SECRET',
  'VAPI_PHONE_NUMBER',
  'PUBLIC_SERVER_URL',
] as const;

/**
 * The three that are exclusively Vapi's — used only to decide whether Vapi
 * was *attempted* at all. `PUBLIC_SERVER_URL` deliberately isn't in this
 * list even though it's required to complete the group (see VAPI_FIELDS):
 * it's shared with Twilio below, so on its own it can't mean "someone meant
 * to configure Vapi" — a Twilio-only deploy sets it too, and must not trip
 * Vapi's "partially configured" error just because they share one field.
 */
const VAPI_SPECIFIC_FIELDS = [
  'VAPI_API_KEY',
  'VAPI_WEBHOOK_SECRET',
  'VAPI_PHONE_NUMBER',
] as const;

/** The four that form Twilio phone-call mode — present together, or not at all. */
const TWILIO_FIELDS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'PUBLIC_SERVER_URL',
] as const;

/** Same reasoning as VAPI_SPECIFIC_FIELDS, mirrored for Twilio. */
const TWILIO_SPECIFIC_FIELDS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
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

  const vapiFullyPresent = VAPI_FIELDS.filter((name) => env[name]);
  const vapiAttempted = VAPI_SPECIFIC_FIELDS.some((name) => env[name]);
  if (vapiFullyPresent.length === VAPI_FIELDS.length) {
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
  } else if (vapiAttempted) {
    // At least one Vapi-specific secret is set but the group isn't complete
    // — almost certainly a mistake (e.g. one secret never got added, or was
    // deleted while rotating), not an intentional "half-configured" state.
    // Checked via vapiAttempted (VAPI_SPECIFIC_FIELDS), not vapiFullyPresent
    // alone: PUBLIC_SERVER_URL is shared with Twilio below, so its presence
    // by itself must not read as "someone meant to configure Vapi."
    const missing = VAPI_FIELDS.filter((name) => !env[name]);
    throw new Error(
      `Phone-call mode is partially configured: missing ${missing.join(', ')}. ` +
        'Set all four Vapi secrets to enable phone mode, or none to leave it ' +
        'disabled — see docs/SETUP.md.',
    );
  }
  // Neither branch: phone mode simply isn't configured. Not an error — it's
  // paused, and a fresh in-person-only deploy shouldn't need it.

  const twilioFullyPresent = TWILIO_FIELDS.filter((name) => env[name]);
  const twilioAttempted = TWILIO_SPECIFIC_FIELDS.some((name) => env[name]);
  if (twilioFullyPresent.length === TWILIO_FIELDS.length) {
    const serverUrl = env.PUBLIC_SERVER_URL!.replace(/\/+$/, '');
    config.twilio = {
      accountSid: env.TWILIO_ACCOUNT_SID!,
      authToken: env.TWILIO_AUTH_TOKEN!,
      phoneNumber: env.TWILIO_PHONE_NUMBER!,
      serverUrl,
      voiceWebhookUrl: `${serverUrl}/twilio/voice`,
      statusWebhookUrl: `${serverUrl}/twilio/status`,
      streamUrlBase: `${serverUrl.replace(/^http/, 'ws')}/twilio/stream`,
    };
  } else if (twilioAttempted) {
    // Same reasoning as the Vapi partial-config check above, mirrored: gated
    // on twilioAttempted (TWILIO_SPECIFIC_FIELDS) rather than
    // twilioFullyPresent alone, for the same shared-PUBLIC_SERVER_URL reason.
    const missing = TWILIO_FIELDS.filter((name) => !env[name]);
    throw new Error(
      `Twilio phone-call mode is partially configured: missing ${missing.join(', ')}. ` +
        'Set all four Twilio secrets to enable it, or none to leave it ' +
        'disabled — see docs/SETUP.md.',
    );
  }
  // Neither branch: Twilio phone mode simply isn't configured.

  if (env.OPENAI_API_KEY) {
    config.openai = { apiKey: env.OPENAI_API_KEY };
  }

  return config;
}
