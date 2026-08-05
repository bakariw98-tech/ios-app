# Setting up Vapi

Everything Vapi-related lives in **`backend/.env`**. Nothing is hardcoded, and
there are no assistants to build in the Vapi dashboard — they're defined in code
and served to Vapi at call time.

```bash
cd backend
cp .env.example .env
```

## The five values

| Variable | Where it comes from |
| --- | --- |
| `VAPI_API_KEY` | Vapi dashboard → **API Keys** → the **private** key. Not the public one — the public key is for browser SDKs and can't do server calls. |
| `VAPI_PHONE_NUMBER` | Vapi dashboard → **Phone Numbers** → buy or import a number. Copy it in E.164 (`+15551234567`). This is the number users dial. |
| `VAPI_PHONE_NUMBER_ID` | Same page, the UUID of that number. |
| `VAPI_WEBHOOK_SECRET` | **You invent this.** Any long random string — `openssl rand -hex 32`. You'll paste the same value into Vapi below. |
| `PUBLIC_SERVER_URL` | A public HTTPS URL pointing at your backend. In dev: `ngrok http 3000` and use the `https://….ngrok.app` URL. No trailing slash. |

## Point the phone number at your backend

In the Vapi dashboard, open your phone number and set:

- **Server URL** → `<PUBLIC_SERVER_URL>/vapi/webhook`
- **Server URL Secret** → the same string you put in `VAPI_WEBHOOK_SECRET`

Vapi sends that secret as the `x-vapi-secret` header; `backend/src/routes/webhook.ts`
compares it in constant time and drops anything that doesn't match.

That's the whole dashboard setup. **Do not create an assistant in the dashboard**
— when a call comes in, Vapi asks our server what to do (`assistant-request`) and
we return `interviewAssistant(...)`. The delegate assistant is returned the same
way at handoff. Keeping both in code is what lets the compliance tests assert on
them; a dashboard-configured assistant would be invisible to CI.

## Run it

```bash
npm install
npm run dev          # backend on :3000
ngrok http 3000      # in another shell — put the https URL in PUBLIC_SERVER_URL
```

Then call your Vapi number from a real phone. You should hear the interview
assistant open with "Hi — I'm here to help you say something that's hard to say."

## What to watch on the first call

Tail the backend logs. These are the lines that matter:

- `COMPLIANCE BACKSTOP: forcing disclosure` — the model failed to hand off when
  the recipient joined and the server had to speak the introduction itself. Not
  fatal, but it's a bug: check the transcript to see what it heard.
- `Handoff without arming` — it jumped straight to the delegate without entering
  the merge window, so the quiet period never applied.
- `Intent extraction failed at handoff` — the interview didn't produce a usable
  intent object and the call was ended rather than continued. Look at which
  fields were missing.
- `COMPLIANCE: call completed without AI disclosure` — post-call analysis says
  the recipient was never told. This should be impossible; treat it as a stop-
  everything bug.

## Notes

- **Recording is off** (`ARTIFACT_PLAN` in `backend/src/assistants/shared.ts`).
  Transcripts and summaries still work — those come from the transcriber, not the
  recorder. See ADR-004 for why, and read `docs/compliance.md` before turning it
  on, because it changes what the consent question has to say.
- **Never commit `.env`.** It's gitignored. `.env.example` is the template and
  holds no real values.
- The backend never places calls. There's no Vapi credential here that's used to
  dial anyone — the API key reads call state and drives live-call control on a
  call the user already started.
