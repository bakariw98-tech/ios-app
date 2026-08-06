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

## 2. Deploying

**Active path: GitHub Actions.** `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are set as repository secrets, and
`.github/workflows/deploy.yml` runs on every push to `main` or the feature
branch: tests first, then `wrangler d1 execute` to apply the schema, then
`wrangler deploy`.

Pull requests run the tests but never deploy — a PR can come from a fork, and a
fork build must not get the Cloudflare token.

Watch runs at **https://github.com/bakariw98-tech/ios-app/actions**.

<details>
<summary>Alternative: Cloudflare Workers Builds (don't set up both)</summary>

Cloudflare can pull from GitHub directly, needing no GitHub secrets at all:

1. Cloudflare dashboard → **Workers & Pages** → **Create application**
2. Next to **Import a repository**, choose **Get started**
3. Authorise GitHub, pick `bakariw98-tech/ios-app`
4. Configure — the defaults are wrong for this repo:

   | Field | Value |
   | --- | --- |
   | **Worker name** | `conversation-delegation` |
   | **Root directory** | `backend` |
   | **Build command** | `npm ci` |
   | **Deploy command** | `npx wrangler deploy` |
   | **Branch** | `claude/conversation-delegation-app-6m6kat` |

The Worker name must match the `name` in `backend/wrangler.toml` or the build
fails, and the root directory must be `backend` because that's where
`wrangler.toml` lives.

Note this path runs `wrangler deploy` but *not* `wrangler d1 execute`, so schema
changes wouldn't reach D1 automatically — unlike the Actions workflow, which
applies them.

**If you enable this, disable the deploy job in the Actions workflow.** Two
deploy mechanisms firing on the same push race each other, and the loser
silently overwrites the winner.

</details>

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

The Worker must exist before you can set these, so **let step 2 deploy once
first**, then add the secrets, then re-run the workflow (Actions → the latest
run → **Re-run all jobs**).

Until the secrets are set, the Worker returns `500 server misconfigured` and
logs exactly which ones are missing — that's expected on the first deploy, not a
broken build.

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
- **Schema changes apply automatically** on the GitHub Actions path — the
  workflow runs `wrangler d1 execute` against `schema.sql` before deploying, and
  every statement is `CREATE ... IF NOT EXISTS`, so it is safe to re-run.
- **The Worker never places calls.** The Vapi API key here reads call state and
  drives live-call control on a call the user already started. There is no
  outbound-call code path — see N4 in `docs/compliance.md`.
- **`npm audit` reports advisories in `undici` via `miniflare` via `wrangler`.**
  All three are dev dependencies; miniflare is the local dev runtime and never
  ships. The deployed Worker bundles only `hono` and `zod`.
- The MCP connector (`npm run mcp`) is a local Node process that talks to the
  deployed Worker over HTTP. Set `BACKEND_URL` to your Worker URL.
