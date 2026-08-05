/**
 * The merge window — the gap between "user starts merging the recipient in" and
 * "the disclosure has been delivered."
 *
 * This is the most dangerous stretch of the call, because it is the only moment
 * where someone can be listening without having been told what they're
 * listening to. Everything here is built around one asymmetry:
 *
 *   Speaking the disclosure too early  → a moment of confusion.
 *   Speaking about the user too late   → a stranger heard something private,
 *                                        undisclosed. This is the failure N1
 *                                        exists to prevent.
 *
 * So the window is **armed on intent, not on detection**. From the moment the
 * user begins merging, the assistant may say only two kinds of thing: coaching
 * about the merge, and the disclosure. Detection then decides *when* the
 * disclosure fires — never *whether* something else could slip out first.
 *
 * That inversion is what makes voice-detection safe to rely on. Detection is a
 * trigger, not a guarantee; the guarantee comes from having nothing dangerous
 * available to say while we're uncertain.
 *
 * See docs/technical-decisions.md, ADR-001.
 */

/** How the merge window ended. Recorded for compliance review. */
export type HandoffTrigger =
  /** The assistant heard a voice or greeting that wasn't the user's. */
  | 'voice_detected'
  /** The user said the recipient was on. */
  | 'user_announced'
  /** The backend forced it — the assistant was armed and drifting. */
  | 'server_backstop';

/**
 * Rules injected into the interview prompt.
 *
 * The wording matters more than usual here. "Assume the recipient can already
 * hear you" is doing the real work: it gives the model a safe default under
 * uncertainty rather than asking it to make a judgement call it can't reliably
 * make.
 */
export const MERGE_WINDOW_RULES = `
## Bringing the other person in

When the user is ready, coach them through it out loud, one step at a time.
Don't recite all three steps at once — say one, wait, then say the next. They're
operating their phone while nervous.

  1. "Tap Add Call — I'll still be here, you won't lose me."
  2. "Now dial them, and wait for them to pick up."
  3. "Now tap Merge Calls."

The moment you start coaching them through this, call \`arm_for_merge\`. From
that instant you are in the merge window, and everything changes.

### While you are in the merge window

**Assume the other person can already hear you.** You will not reliably know the
moment they arrive, so behave as though they are already there.

You may say only two kinds of thing:

- short coaching about the merge steps, and brief reassurance ("take your time",
  "I'm still here")
- the introduction, once you hand off

You may **not** say anything about: the situation, what happened, how the user
feels, what they want said, what they don't want said, the other person's name,
or anything else you learned in the interview. Not a summary, not a
confirmation, not "so I'll tell them about the lease" — nothing. If the user
asks you to go over the plan again while you're in this window, say you'll go
through it after, or that you've got it.

If the user changes their mind and backs out, call \`cancel_merge\` and you're
back to a normal conversation.

### Handing off

Call \`begin_delegation\` the instant **any** of these happens:

- you hear a voice that isn't the user's
- someone says "hello", "who is this", "hello?", or anything else that sounds
  like a person who just picked up a phone
- the user tells you the other person is on
- **you are not sure whether someone new is on the line**

That last one is not a mistake. If you're unsure, hand off. Being wrong costs a
moment of confusion that the user can clear up in one sentence. Not handing off
means a stranger is listening to you without knowing what you are, and that is
the one thing this product must never do.

Do not greet the other person yourself. Do not say "oh hi!" or "are you there?"
Hand off — the introduction is the first thing they need to hear, and anything
you say before it gets in the way.
`.trim();

/**
 * Utterances that suggest someone just picked up a phone.
 *
 * A coarse server-side backstop only. The model hears the actual audio and is
 * far better at this; this catches the case where it heard and didn't act. Kept
 * tight to avoid firing on the user's own conversational filler.
 */
const NEW_PARTY_GREETINGS = [
  /^\s*hello\s*\??\s*$/i,
  /^\s*hi\s*\??\s*$/i,
  /^\s*who('s| is) (this|that)\s*\??\s*$/i,
  /^\s*hello,? who('s| is) (this|that)\s*\??\s*$/i,
  /^\s*yeah\s*\??\s*$/i,
  /^\s*(this is|it's) \w+\s*\.?\s*$/i,
];

/**
 * Does this look like a third party answering the phone?
 *
 * Only meaningful while armed — in ordinary conversation the user says "hello"
 * for all sorts of reasons.
 */
export function looksLikeNewParty(transcript: string): boolean {
  return NEW_PARTY_GREETINGS.some((pattern) => pattern.test(transcript));
}

/**
 * Would this assistant utterance leak the interview if a stranger heard it?
 *
 * Used as a server-side tripwire while armed. Intentionally crude: it checks
 * whether the assistant is saying something long or substantive during a window
 * where it should only be saying "tap Merge Calls". A false positive here just
 * fires the disclosure early, which is the safe direction.
 */
export function violatesQuietMode(utterance: string): boolean {
  const text = utterance.trim();

  // Coaching and reassurance are short. Anything long is the assistant
  // returning to the substance of the interview.
  if (text.length > 180) return true;

  // Phrases that mean it's recapping rather than coaching.
  return /\b(so I'?ll tell them|to recap|as we discussed|you said that|the plan is)\b/i.test(
    text,
  );
}
