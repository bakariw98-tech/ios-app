# Setup

The backend runs as a **Cloudflare Worker** and deploys from GitHub Actions on
push. You never run a command locally — everything below is web UI plus a `git
push`.

## Why Workers rather than Render/Railway/Fly

Vapi's `assistant-request` webhook has a **~7.5 second budget**: miss it and the
call drops. Free tiers on container hosts spin down when idle and cold-start in
tens of seconds, which would blow that budget on exactly the calls that matter —
the first one after a quiet period. Workers run as V8 isolates with no cold
start (~5ms). This is an architectural constraint, not a preference.

---

## 1. Cloudflare

Already done, via this session:

- **D1 database** `conversation-delegation`
  (`c533ed3b-93ac-4f3b-8802-ad5fd73dafb5`), schema applied.
- `backend/wrangler.toml` references it by id.

You need to create an **API token** so GitHub can deploy:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**
2. Use the **Edit Cloudflare Workers** template
3. Add D1 permission: **Account → D1 → Edit**
4. Create, copy the token (shown once)

Also grab your **Account ID** from the right-hand sidebar of any Cloudflare
dashboard page.

## 2. GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | your account id |

That's all GitHub needs. Pushing to the feature branch or `main` now runs tests
and deploys.

## 3. Vapi

Sign up at vapi.ai, then:

| Value | Where from |
| --- | --- |
| **API key** | Dashboard → **API Keys** → the **private** key. Not the public one — that's for browser SDKs and can't do server calls. |
| **Phone number** | Dashboard → **Phone Numbers** → buy or import. Copy in E.164 (`+15551234567`). This is the number users dial. |
| **Phone number id** | Same page, the UUID. |

## 4. Worker secrets

Cloudflare dashboard → **Workers & Pages → conversation-delegation → Settings →
Variables and Secrets**. Add each as a **Secret** (not a plaintext variable):

| Name | Value |
| --- | --- |
| `VAPI_API_KEY` | private key from step 3 |
| `VAPI_PHONE_NUMBER` | `+15551234567` |
| `VAPI_PHONE_NUMBER_ID` | the UUID |
| `VAPI_WEBHOOK_SECRET` | **you invent this** — any long random string |
| `PUBLIC_SERVER_URL` | your Worker URL, e.g. `https://conversation-delegation.<subdomain>.workers.dev` — no trailing slash |

The Worker must exist before you can set these, so **push once first** to create
it, then add the secrets, then push again (or hit **Retry deployment**).

## 5. Point Vapi at the Worker

In Vapi, open your phone number and set:

- **Server URL** → `<PUBLIC_SERVER_URL>/vapi/webhook`
- **Server URL Secret** → the same string as `VAPI_WEBHOOK_SECRET`

Vapi sends it as the `x-vapi-secret` header; the Worker compares it in constant
time and drops anything that doesn't match.

**Do not create an assistant in the Vapi dashboard.** When a call comes in, Vapi
asks our Worker what to do (`assistant-request`) and we return
`interviewAssistant(...)` from code. The delegate assistant is returned the same
way at handoff. Keeping both in code is what lets the compliance tests assert on
them — a dashboard-configured assistant would be invisible to CI.

## 6. Make a call

Dial your Vapi number from a real phone. You should hear:

> "Hi — I'm here to help you say something that's hard to say. Take your time.
> What's going on?"

Talk it through, then when it coaches you: **Add Call → dial → Merge Calls**. The
assistant should introduce itself to them within a second or two of hearing them.

---

## Watching a live call

Cloudflare dashboard → Workers → **conversation-delegation → Logs → Live**.
Observability is on in `wrangler.toml`, so logs stream in real time.

The lines that matter:

- `COMPLIANCE BACKSTOP on <id>` — the model failed to hand off when the
  recipient joined and the Worker spoke the introduction itself. Not fatal, but
  a bug: check the transcript to see what it heard.
- `Handoff without arming on <id>` — it jumped straight to the delegate without
  entering the merge window, so the quiet period never applied.
- `Intent extraction failed at handoff on <id>` — the interview didn't produce a
  usable intent object; the call was ended rather than continued. Look at which
  fields were missing.
- `COMPLIANCE on <id>: completed without AI disclosure` — post-call analysis says
  the recipient was never told. This should be impossible. Stop and investigate.

To inspect stored calls: Cloudflare dashboard → **Storage & Databases → D1 →
conversation-delegation → Console**, then e.g.

```sql
SELECT call_id, phase, handoff_trigger, backstop_fired FROM calls
ORDER BY started_at DESC LIMIT 20;
```

## Notes

- **Recording is off** (`ARTIFACT_PLAN` in `backend/src/assistants/shared.ts`).
  Transcripts and summaries still work — they come from the transcriber, not the
  recorder. Read `docs/compliance.md` before turning it on; it changes what the
  consent question has to say.
- **The Worker never places calls.** The Vapi API key here reads call state and
  drives live-call control on a call the user already started. There is no
  outbound-call code path — see N4 in `docs/compliance.md`.
- **`npm audit` reports advisories in `undici` via `miniflare` via `wrangler`.**
  All three are dev dependencies; miniflare is the local dev runtime and never
  ships. The deployed Worker bundles only `hono` and `zod`.
- The MCP connector (`npm run mcp`) is a local Node process that talks to the
  deployed Worker over HTTP. Set `BACKEND_URL` to your Worker URL.
