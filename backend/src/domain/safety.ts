/**
 * Hard-block screening.
 *
 * Four categories are refused outright (docs/compliance.md). Screening runs
 * twice: during the interview, as a tool the interview assistant calls when it
 * suspects one applies, and again as a gate immediately before the handoff.
 *
 * Design notes:
 *
 * - Keyword matching here is a *floor*, not the mechanism. The real screening is
 *   the interview assistant's judgement, prompted below. Keywords catch the
 *   cases where the model missed something obvious; they are not expected to be
 *   sufficient and must not be treated as such.
 * - Refusals are warm and give somewhere to go. Someone hitting the domestic
 *   violence block is having the worst day of their life, and a curt "this
 *   request was denied" is a bad thing to do to them.
 */

export type BlockCategory =
  | 'domestic_violence'
  | 'minor'
  | 'debt_collection'
  | 'legal_counterparty';

export interface ScreeningResult {
  blocked: boolean;
  category?: BlockCategory;
  /** Spoken to the user by the interview assistant, verbatim. */
  spokenRefusal?: string;
  /** Shown in-app alongside the spoken refusal. */
  appMessage?: string;
}

/**
 * Signals that warrant a second look. Intentionally over-inclusive: a false
 * positive costs one clarifying question, a false negative puts someone in
 * danger.
 */
const SIGNALS: Record<BlockCategory, RegExp[]> = {
  domestic_violence: [
    /\brestraining order\b/i,
    /\bprotective order\b/i,
    /\bno.?contact order\b/i,
    /\b(he|she|they) (hit|hits|beat|beats|hurt|hurts) me\b/i,
    /\bafraid (of|for) my (safety|life)\b/i,
    /\bdomestic (violence|abuse)\b/i,
    /\bshelter\b/i,
    /\bstalking\b/i,
  ],
  minor: [
    /\b(my|their|his|her) (kid|child|son|daughter)\b.*\b(is|turns|turned)\s*(1?[0-9])\b/i,
    /\b(1[0-7]|[1-9])[\s-]?(year|yr)s?[\s-]?old\b/i,
    /\bunderage\b/i,
    /\b(middle|elementary|high) school\b/i,
    /\bminor\b/i,
  ],
  debt_collection: [
    /\b(collect|collecting|recover|recovering)\b.*\b(debt|money|loan|payment)s?\b/i,
    /\bthey owe me\b/i,
    /\bpay(ment)? (is )?(overdue|late|past due)\b/i,
    /\bcollections? agency\b/i,
    /\bdebt\b/i,
  ],
  legal_counterparty: [
    /\b(my|their|the) (lawyer|attorney|counsel)\b/i,
    /\b(suing|sue|lawsuit|litigation|court date|deposition)\b/i,
    /\bopposing (party|counsel)\b/i,
    /\bsettlement\b/i,
    /\binsurance (claim|adjuster)\b/i,
  ],
};

const REFUSALS: Record<BlockCategory, { spoken: string; app: string }> = {
  domestic_violence: {
    spoken:
      "I want to stop here, and I want to be honest with you about why. From " +
      "what you're describing, there may be safety involved — and having an AI " +
      "make contact could make things harder for you, or affect something legal " +
      "that's already in place. That's not a risk I'm willing to take with your " +
      "safety. This is worth talking through with someone trained for it. In " +
      "the US, the National Domestic Violence Hotline is 800-799-7233, and " +
      "they're there around the clock. I'm sorry I can't be the help you needed " +
      "today.",
    app:
      "We can't help with this one — where safety may be involved, an AI " +
      "making contact can escalate things or interfere with a protective " +
      "order. The National Domestic Violence Hotline (800-799-7233, 24/7) has " +
      "people trained for exactly this.",
  },
  minor: {
    spoken:
      "I can't help with this one. I'm not able to speak with anyone under 18 " +
      "on someone else's behalf — that's a firm line for us regardless of the " +
      "situation. If this is a conversation that needs to happen, it needs to " +
      "come from you directly, or through a parent or guardian.",
    app:
      "We don't place delegated conversations with anyone under 18. This one " +
      "needs to come from you directly, or through a parent or guardian.",
  },
  debt_collection: {
    spoken:
      "I have to pass on this one. Anything that amounts to collecting a debt " +
      "falls under rules I'm not set up to handle, even between people who know " +
      "each other. It's not a judgement about your situation — it's just " +
      "outside what I can do.",
    app:
      "Debt collection falls under separate rules (FDCPA) that this product " +
      "isn't built for, even between people who know each other.",
  },
  legal_counterparty: {
    spoken:
      "I'm going to stop us here. When there's a legal matter or a lawyer " +
      "involved on the other side, anything I say for you could end up " +
      "mattering in ways neither of us intends. That's a conversation to have " +
      "through your own lawyer, not through me.",
    app:
      "When there's a legal matter or counsel on the other side, delegated " +
      "statements can carry consequences. This should go through your own " +
      "lawyer.",
  },
};

/** Keyword floor. See the note at the top — this backs up the model, not the reverse. */
export function screenText(text: string): ScreeningResult {
  for (const [category, patterns] of Object.entries(SIGNALS) as [
    BlockCategory,
    RegExp[],
  ][]) {
    if (patterns.some((p) => p.test(text))) {
      return block(category);
    }
  }
  return { blocked: false };
}

export function block(category: BlockCategory): ScreeningResult {
  const refusal = REFUSALS[category];
  return {
    blocked: true,
    category,
    spokenRefusal: refusal.spoken,
    appMessage: refusal.app,
  };
}

/**
 * Screening instructions for the interview assistant's system prompt.
 *
 * This is where the actual work happens — the model has the conversation, so the
 * model is what notices.
 */
export const SAFETY_PROMPT_RULES = `
## Situations you must stop for

Four kinds of situation are outside what this product does. If you come to
believe you're in one, call the \`flag_blocked_situation\` tool immediately with
the category, then say exactly what it gives you back. Do not soften it, do not
add hope to it, and do not continue the interview afterwards.

1. **domestic_violence** — any indication of abuse, fear for physical safety,
   stalking, or an existing restraining/protective/no-contact order. An AI
   making contact can escalate danger and can violate a court order.
2. **minor** — the recipient appears to be under 18.
3. **debt_collection** — the purpose is to recover money owed, however
   informally, even between friends.
4. **legal_counterparty** — the recipient is an opposing party, a lawyer, an
   insurer, or anyone the user is in a dispute or proceeding with.

Judgement notes:

- Weigh the *situation*, not the vocabulary. Someone saying "my ex is going to be
  furious" is describing an emotion. Someone saying "my ex isn't supposed to
  contact me" is describing an order. Those are very different and you should
  treat them differently.
- When you're unsure, ask one gentle clarifying question before flagging. "Can I
  ask — is there anything about this that's made you worried for your safety?"
  is a reasonable thing to ask, and asking is much better than guessing wrong in
  either direction.
- If it's genuinely ambiguous after asking, flag it. The cost of a wrong refusal
  is that someone makes a phone call themselves. The cost of a wrong approval
  can be someone getting hurt.
`.trim();
