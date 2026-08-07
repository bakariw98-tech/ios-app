/**
 * The intent object's structural guarantees.
 *
 * Two things are protected here. First, the hand-written JSON Schema staying
 * in lockstep with the zod schema — they are kept in sync by this test rather
 * than by generation (see the schema's doc comment for why), so drift has to
 * fail loudly here or it fails as a live 400 instead. Second, the render
 * ordering, which is not cosmetic: the goal leads so it frames everything read
 * after it, and the hard limits land last because recency is what keeps them
 * from being quietly traded away deep into an argument.
 */

import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_INTENT_JSON_SCHEMA,
  ConversationIntentSchema,
  type ConversationIntent,
  renderIntentForConversation,
} from '../src/domain/conversationIntent.js';

const intent: ConversationIntent = {
  userFirstName: 'Sam',
  recipientName: 'Alex',
  relationship: 'friend',
  goal: 'Alex agrees to meet up in person and talk properly.',
  context:
    'They fell out in March after an argument about the shared lease. Sam sent ' +
    'one message in April that Alex never answered.',
  feelings: 'Sad, and tired of the silence.',
  mustSay: ['I should have called sooner'],
  neverSay: ["Alex's new partner", 'the money Sam lent them'],
  acceptableCompromises: [
    'A phone call instead of meeting in person',
    'Meeting somewhere public rather than at home',
  ],
  hardLimits: ['Will not apologise for moving out'],
  questionsToAnswer: ['Does Alex still want to be friends at all?'],
  tone: 'warm',
};

describe('JSON Schema stays in sync with the zod schema', () => {
  const zodKeys = Object.keys(ConversationIntentSchema.shape).sort();

  it('describes exactly the same fields', () => {
    const jsonKeys = Object.keys(
      CONVERSATION_INTENT_JSON_SCHEMA.properties,
    ).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });

  it('marks every field required — strict mode has no optional properties', () => {
    expect([...CONVERSATION_INTENT_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
  });

  it('sets additionalProperties: false, as strict mode demands', () => {
    expect(CONVERSATION_INTENT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('keeps the relationship and tone enums identical to the zod enums', () => {
    expect([...CONVERSATION_INTENT_JSON_SCHEMA.properties.relationship.enum]).toEqual(
      ConversationIntentSchema.shape.relationship.options,
    );
    expect([...CONVERSATION_INTENT_JSON_SCHEMA.properties.tone.enum]).toEqual(
      ConversationIntentSchema.shape.tone.options,
    );
  });

  it('accepts a fully-populated intent', () => {
    expect(ConversationIntentSchema.safeParse(intent).success).toBe(true);
  });

  it('rejects an intent with no goal — the one field the engine cannot run without', () => {
    expect(
      ConversationIntentSchema.safeParse({ ...intent, goal: '' }).success,
    ).toBe(false);
  });
});

describe('renderIntentForConversation — ordering', () => {
  const rendered = renderIntentForConversation(intent);

  it('leads with the goal, ahead of the backstory and the limits', () => {
    const goalAt = rendered.indexOf('THE GOAL');
    const contextAt = rendered.indexOf('What actually happened');
    const limitsAt = rendered.indexOf('HARD LIMITS');

    expect(goalAt).toBeGreaterThanOrEqual(0);
    expect(goalAt).toBeLessThan(contextAt);
    expect(goalAt).toBeLessThan(limitsAt);
  });

  it('puts the hard limits last, after the negotiating room', () => {
    expect(rendered.indexOf('Room to negotiate')).toBeLessThan(
      rendered.indexOf('HARD LIMITS'),
    );
  });
});

describe('renderIntentForConversation — content', () => {
  const rendered = renderIntentForConversation(intent);

  it('carries the goal verbatim', () => {
    expect(rendered).toContain(intent.goal);
  });

  it('carries every hard limit and never-say item', () => {
    for (const item of [...intent.hardLimits, ...intent.neverSay]) {
      expect(rendered).toContain(item);
    }
  });

  it('carries every compromise', () => {
    for (const item of intent.acceptableCompromises) {
      expect(rendered).toContain(item);
    }
  });

  it('grants compromises as standing authority, not as suggestions to clear first', () => {
    expect(rendered).toMatch(/WITHOUT\s+asking/i);
  });

  it('states outright that a limit beats the goal', () => {
    expect(rendered).toMatch(
      /the\s+limit\s+wins\s+and\s+the\s+goal\s+does\s+not\s+happen/i,
    );
  });

  it('tells the model to report feelings rather than perform them', () => {
    expect(rendered).toMatch(/Report\s+it\s+—\s+do\s+not\s+perform\s+it/i);
  });

  it('renders empty lists as an explicit "none", never as a blank section', () => {
    const bare = renderIntentForConversation({
      ...intent,
      mustSay: [],
      neverSay: [],
      acceptableCompromises: [],
      hardLimits: [],
      questionsToAnswer: [],
    });
    expect(bare).toContain('(none given)');
    // A blank bullet would read as an unfinished instruction to the model.
    expect(bare).not.toMatch(/^-\s*$/m);
  });

  it('never instructs the model to stop at what it was given', () => {
    // The retired relay prompt (domain/intent.ts) ends with "You have nothing
    // to say beyond what is written above" — precisely the instruction that
    // makes negotiation impossible. It must not reappear here.
    expect(rendered).not.toMatch(/nothing\s+to\s+say\s+beyond/i);
  });
});
