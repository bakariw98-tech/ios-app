/**
 * The brief — the entire input to in-person mode.
 *
 * Deliberately much smaller than the phone-call flow's Intent object
 * (src/domain/intent.ts). There is no separate interview step here: the user
 * types or speaks one quick brief, and the model starts talking immediately.
 * See docs/technical-decisions.md, ADR-005, for why that's the right shape
 * for this mode rather than a simplified version of the phone-call interview.
 */

import { z } from 'zod';

export const BriefSchema = z.object({
  /**
   * What the user typed or said, roughly as given. Deliberately not broken
   * into structured fields (situation / goal / boundaries) the way the
   * phone-call Intent is — there's no interview step to populate them, and
   * asking the user to fill out a form defeats the "quick brief, start
   * talking" premise this mode exists for.
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

If they ask you something the brief already answers, answer it directly and
confidently. If they ask something the brief doesn't cover, and it's a small
factual thing you could reasonably infer (spelling a name, confirming a
straightforward "yes" to something obviously implied), use judgment. If it's
a real decision — do they want to spend more, change the order, give out
information the brief didn't include — stop and ask ${addressAs} directly, out
loud, by name if you have it. They can hear you and can jump in themselves at
any point; when they do, follow them, they outrank the brief.

Keep it natural and brief. You're not narrating what you're doing ("I will
now place the order") — you're just doing it, the way a person would.

## Ending

Wind down naturally once the exchange is done — once the order's placed, the
question's answered, the thing is handed over, whatever "done" looks like for
this brief. Don't linger.

If it turns confrontational or the other person pushes back hard on something
${addressAs} needs to weigh in on, stop and hand it to them rather than
improvising a resolution.
`.trim();
}
