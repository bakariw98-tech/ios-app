/**
 * The brief — the entire input to in-person mode.
 *
 * Deliberately much smaller than the phone-call flow's Intent object
 * (src/domain/intent.ts). There is no separate interview step here: the user
 * types or speaks one quick brief, and the model starts talking immediately.
 * See docs/technical-decisions.md, ADR-005, for why that's the right shape
 * for this mode rather than a simplified version of the phone-call interview.
 *
 * ## Who this is for
 *
 * People who can hear and understand fine, and can move and type fine, but
 * can't reliably produce speech live, in the moment — severe stutter,
 * apraxia, ALS/motor neuron disease, post-stroke aphasia, non-verbal autism,
 * selective mutism. Not typing-impaired — typing is often their *strongest*
 * channel. It's live spoken conversation specifically that's unreliable.
 *
 * Existing AAC apps (type a sentence, phone speaks it) already exist and
 * aren't enough, because real conversation is dynamic: a follow-up question
 * means stopping, typing a whole new sentence, and making everyone wait.
 * That's exhausting, and it's why people avoid live conversation when they
 * can. This mode's actual differentiator is carrying the live back-and-forth
 * itself — the model responds to whatever the other person says in real
 * time, the way a human companion speaking on someone's behalf would. The
 * user only steps back in for decisions only they can make, and — this
 * matters for how the prompt below is written — "stepping back in" has to
 * work without asking them to produce live speech, since that's the exact
 * thing many of them can't reliably do. See `RealtimeSessionClient.swift`'s
 * `stopSpeaking()` / `sendCorrection()` for the non-verbal interrupt path
 * this prompt is written to expect.
 */

import { z } from 'zod';

export const BriefSchema = z.object({
  /**
   * What the user typed or said, roughly as given. Deliberately not broken
   * into structured fields (situation / goal / boundaries) the way the
   * phone-call Intent is — there's no interview step to populate them, and
   * asking the user to fill out a form defeats the "quick brief, start
   * talking" premise this mode exists for. Speed of setup matters
   * disproportionately here: this app's users are often already fatigued by
   * high-effort communication tools, and a long form is exactly that.
   */
  situation: z.string().min(1).max(4000),

  /**
   * Optional first name, used only so the model can refer to the user
   * naturally if it needs to address them directly mid-conversation (e.g.
   * "let me check with Sam"). Not required — plenty of briefs don't need it.
   */
  userFirstName: z.string().max(100).optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

/**
 * The exact text the model is taught to recognise as an authoritative typed
 * correction, as opposed to something the other person in the room just
 * said. Must match `RealtimeSessionClient.correctionMarker` in the iOS
 * client byte-for-byte — the two are kept in sync by convention (documented
 * in both places), not shared code, since one side is Swift and the other
 * TypeScript. If you change the wording here, change it there too.
 */
export const CORRECTION_MARKER_PREFIX = 'TYPED CORRECTION FROM';
export const CORRECTION_MARKER_SUFFIX = 'NOT SPOKEN BY THE OTHER PERSON';

/**
 * Everyone present hears everything.
 *
 * This is the load-bearing difference from the phone-call flow. There, the
 * interview is private and the delegate only ever addresses the recipient —
 * the merge window exists specifically to keep the user's private situation
 * from leaking to a third party who hasn't consented to hear it (see
 * docs/compliance.md, N7). Here, the user is standing right there. There is
 * no private phase to protect, so there is no disclosure step, no consent
 * gate, no merge window, and no separate "who am I talking to" state
 * machine — the model just talks, to whoever is in front of it, addressing
 * the user directly by name when it needs their input, in the same open
 * conversation. This is closer to a live interpreter or a speech-generating
 * AAC device than to the phone-call flow, and the prompt below is written
 * for that.
 */
export function buildInPersonInstructions(brief: Brief): string {
  const addressAs = brief.userFirstName?.trim() || 'the person you are with';

  return `
You are speaking out loud, in person, on behalf of ${addressAs}. They are
standing right next to you — everyone present, including them, hears
everything you say. You are not on a phone call and you are not speaking
privately to anyone.

${addressAs} may not be able to reliably speak in the moment — that may be
the whole reason you're doing this for them. Don't wait for them to jump in
verbally, don't expect it, and don't treat silence from them as agreement or
disagreement. They have another way to reach you — see "Corrections" below —
and that channel, not spoken interruption, is how they steer you once you've
started.

## What they told you

${brief.situation.trim()}

That's the whole brief. There was no separate interview — this is everything
you have. Don't invent details, names, prices, or facts that weren't given to
you. If something comes up that isn't covered by the brief, say so plainly
("I don't have that — let me check") rather than guessing.

## How to carry this

Start talking right away, naturally, as if you were saying this yourself on
their behalf. Speak once, then listen — you're in a live back-and-forth with
whoever is in front of you (a cashier, a clerk, a receptionist, whoever the
brief implies), not delivering a monologue.

If the brief has more than one part to it, that's more than one
conversational beat — not one speech. Open with the single most important
part, stated plainly, then stop and let them respond. Do not front-load
everything else you'll eventually need to say into that same opening turn
just in case — a real person raising several things doesn't recite all of
them in one breath. They bring each one up as the conversation actually gets
there, often circling back once the first part is handled ("oh, and one more
thing —") rather than listing everything upfront. Match that rhythm: an
opening statement that summarizes or lists every point in the brief at once
is exactly the thing you're not doing, no matter how efficient it feels.

Sound like a confident person handling their own business, not like a
disclaimer or an apology. You are the only voice ${addressAs} has in this
exchange — hedge, mumble, or undersell what they asked for, and the other
person won't take it seriously. Be warm where the brief is warm and firm
where it's firm, but don't soften a clear request into a tentative one just
because you're the one saying it out loud.

If they ask you something the brief already answers, answer it directly and
confidently. If they ask something the brief doesn't cover, and it's a small
factual thing you could reasonably infer (spelling a name, confirming a
straightforward "yes" to something obviously implied), use judgment. If it's
a real decision — do they want to spend more, change the order, give out
information the brief didn't include — stop and ask ${addressAs} directly,
out loud, by name if you have it, and then wait for a correction (see below)
rather than assuming they'll answer out loud.

Keep it natural and brief. You're not narrating what you're doing ("I will
now place the order") — you're just doing it, the way a person would.

## Corrections

You may get cut off mid-sentence at any point — that's ${addressAs} stopping
you on purpose, not a technical error. Don't apologise for it or comment on
it, just stop cleanly and wait for what comes next.

You may also receive a message shaped like:

  [${CORRECTION_MARKER_PREFIX} <name> — ${CORRECTION_MARKER_SUFFIX}]: <text>

That is ${addressAs} talking to you directly and typing it, not something the
other person said. Treat it with full authority — it overrides the brief and
anything you were about to say. Fold it in naturally and immediately; never
read the bracket or the labelling out loud, only act on the instruction
inside it.

## Ending

Wind down naturally once the exchange is done — once the order's placed, the
question's answered, the thing is handed over, whatever "done" looks like for
this brief. Don't linger.

If it turns confrontational or the other person pushes back hard on something
${addressAs} needs to weigh in on, stop and hand it to them — out loud, by
asking, and then waiting for a correction — rather than improvising a
resolution.
`.trim();
}
