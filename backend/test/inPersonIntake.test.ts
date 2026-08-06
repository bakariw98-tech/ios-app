import { describe, expect, it } from 'vitest';

import {
  BriefSchema,
  CORRECTION_MARKER_PREFIX,
  CORRECTION_MARKER_SUFFIX,
} from '../src/domain/inPersonBrief.js';
import {
  INTAKE_REPLY_JSON_SCHEMA,
  IntakeReplySchema,
  IntakeRequestSchema,
  MAX_INTAKE_QUESTIONS,
  MAX_INTAKE_TURNS,
  buildIntakeInstructions,
  buildIntakeMessages,
  clampSituation,
  composeTranscriptSituation,
  normalizeIntakeReply,
} from '../src/domain/inPersonIntake.js';

describe('IntakeRequestSchema', () => {
  it('accepts just a situation, with turns defaulting to empty', () => {
    const result = IntakeRequestSchema.safeParse({ situation: 'Order a coffee.' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.turns).toEqual([]);
  });

  it('rejects an empty situation', () => {
    expect(IntakeRequestSchema.safeParse({ situation: '' }).success).toBe(false);
  });

  it('rejects a situation over 4000 characters — same bound as BriefSchema', () => {
    const long = 'a'.repeat(4001);
    expect(IntakeRequestSchema.safeParse({ situation: long }).success).toBe(false);
  });

  it('rejects more turns than MAX_INTAKE_TURNS — the cost guard', () => {
    const turns = Array.from({ length: MAX_INTAKE_TURNS + 1 }, (_, i) => ({
      role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
      text: 'x',
    }));
    expect(IntakeRequestSchema.safeParse({ situation: 'test', turns }).success).toBe(false);
  });

  it('accepts exactly MAX_INTAKE_TURNS turns', () => {
    const turns = Array.from({ length: MAX_INTAKE_TURNS }, (_, i) => ({
      role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
      text: 'x',
    }));
    expect(IntakeRequestSchema.safeParse({ situation: 'test', turns }).success).toBe(true);
  });

  it('rejects a turn with an invalid role', () => {
    const result = IntakeRequestSchema.safeParse({
      situation: 'test',
      turns: [{ role: 'system', text: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional userFirstName', () => {
    const result = IntakeRequestSchema.safeParse({ situation: 'test', userFirstName: 'Sam' });
    expect(result.success).toBe(true);
  });
});

describe('IntakeReplySchema + normalizeIntakeReply', () => {
  it('accepts and normalizes a valid question reply', () => {
    const parsed = IntakeReplySchema.parse({ done: false, question: 'Who are you speaking to?', situation: null });
    const normalized = normalizeIntakeReply(parsed);
    expect(normalized).toEqual({ kind: 'question', question: 'Who are you speaking to?' });
  });

  it('accepts and normalizes a valid done reply', () => {
    const parsed = IntakeReplySchema.parse({ done: true, question: null, situation: 'A full paragraph.' });
    const normalized = normalizeIntakeReply(parsed);
    expect(normalized).toEqual({ kind: 'done', situation: 'A full paragraph.' });
  });

  it('rejects done:true with situation:null as incoherent', () => {
    const parsed = IntakeReplySchema.parse({ done: true, question: null, situation: null });
    expect(() => normalizeIntakeReply(parsed)).toThrow(/no situation/i);
  });

  it('rejects done:false with question:null as incoherent', () => {
    const parsed = IntakeReplySchema.parse({ done: false, question: null, situation: null });
    expect(() => normalizeIntakeReply(parsed)).toThrow(/no question/i);
  });
});

// The single most likely thing to break silently: strict Structured Outputs
// requires additionalProperties:false and every property in `required`. If
// IntakeReplySchema changes without this hand-written JSON Schema following,
// the request would 400 against OpenAI's real API — not something a fetch-mocked
// test elsewhere would catch.
describe('INTAKE_REPLY_JSON_SCHEMA', () => {
  it('has additionalProperties: false, required by OpenAI strict mode', () => {
    expect(INTAKE_REPLY_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('lists every IntakeReplySchema property in both properties and required', () => {
    const zodKeys = Object.keys(IntakeReplySchema.shape).sort();
    expect(Object.keys(INTAKE_REPLY_JSON_SCHEMA.properties).sort()).toEqual(zodKeys);
    expect([...INTAKE_REPLY_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
  });
});

describe('buildIntakeInstructions', () => {
  it('asks exactly one question per turn', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/exactly one question per turn/i);
    expect(instructions).toMatch(/never a list of questions/i);
  });

  it('states the question cap', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toContain(String(MAX_INTAKE_QUESTIONS));
  });

  it('forbids inventing facts', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/never invent details, names, prices, or facts/i);
  });

  it('says the user is typing, never speaking', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/is TYPING to you, not speaking/i);
  });

  it('addresses the user by name when given', () => {
    const instructions = buildIntakeInstructions({ userFirstName: 'Sam' });
    expect(instructions).toContain('Sam');
  });

  it('falls back to a generic address when no name is given', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/the user/);
  });

  // This model is not the delegate — it must never learn the correction
  // marker. If it did and ever echoed bracket-shaped text back, the delegate
  // could mistake it for an authoritative correction. See this file's top
  // doc comment.
  it('never mentions the correction marker or live-session mechanics', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).not.toContain(CORRECTION_MARKER_PREFIX);
    expect(instructions).not.toContain(CORRECTION_MARKER_SUFFIX);
    expect(instructions).toMatch(/no part in/i);
  });

  // Same regression guard inPersonBrief.test.ts has: a stray reference here
  // would mean phone-mode language leaked into the wrong prompt.
  it('never mentions phone-mode language', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).not.toMatch(/merge window/i);
    expect(instructions).not.toMatch(/disclosure/i);
    expect(instructions).not.toMatch(/consent/i);
  });

  // Real-world feedback: the model was walking a fixed topic checklist
  // instead of reasoning about the user's actual goal and what stood between
  // the situation and reaching it. Locks in the fix so it can't silently
  // regress back into checklist-asking.
  it('instructs reasoning about the goal before asking, not a fixed checklist', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/what\s+.*is actually trying to achieve/i);
    expect(instructions).toMatch(/the real goal underneath it/i);
    expect(instructions).toMatch(/what stands\s*\n?\s*between the situation as described and actually reaching it/i);
  });

  it('prioritizes clarifying an unclear goal as the first question', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/if the goal itself isn't clear yet, that's your first question/i);
  });

  it('asks about goal-relevant obstacles, not a generic "anything else"', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/a constraint, a likely complication/i);
  });

  it('has the finalized paragraph state the goal, not just the surface request', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/state the goal plainly, not just the surface request/i);
  });

  // Regression test for a real bad question a live run produced: "which
  // Papa John's are you calling?" — a location detail that changes nothing
  // about what gets said out loud. The earlier "who they're speaking to and
  // where" phrasing invited exactly this; this locks in the fix so it can't
  // come back the same way.
  it('forbids asking about location, address, or which specific branch', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(
      /never ask about administrative or identifying details that don't change/i,
    );
    expect(instructions).toMatch(/which specific branch or location/i);
    expect(instructions).toMatch(/doesn't need to know which store this is/i);
  });

  it('frames the model as the person about to speak, not a form-filler', () => {
    const instructions = buildIntakeInstructions({});
    expect(instructions).toMatch(/you're the one about to open your\s+mouth and speak for them/i);
    expect(instructions).toMatch(/not what would look thorough on a form/i);
  });
});

describe('buildIntakeMessages', () => {
  it('puts the system prompt first, then the original situation as a user message', () => {
    const messages = buildIntakeMessages({
      situation: 'Order a coffee.',
      turns: [],
    });
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'Order a coffee.' });
  });

  it('preserves turn order and roles after the seed message', () => {
    const messages = buildIntakeMessages({
      situation: 'Order a coffee.',
      turns: [
        { role: 'assistant', text: 'What size?' },
        { role: 'user', text: 'Medium.' },
      ],
    });
    expect(messages.slice(2)).toEqual([
      { role: 'assistant', content: 'What size?' },
      { role: 'user', content: 'Medium.' },
    ]);
  });
});

describe('composeTranscriptSituation', () => {
  it('contains the original situation', () => {
    const situation = composeTranscriptSituation({ situation: 'Order a coffee.', turns: [] });
    expect(situation).toContain('Order a coffee.');
  });

  it('contains every user answer, labelled', () => {
    const situation = composeTranscriptSituation({
      situation: 'Order a coffee.',
      turns: [
        { role: 'assistant', text: 'What size?' },
        { role: 'user', text: 'Medium, oat milk.' },
      ],
    });
    expect(situation).toContain('Medium, oat milk.');
    expect(situation).toMatch(/Asked:.*What size\?/);
    expect(situation).toMatch(/Answered:.*Medium, oat milk\./);
  });

  it('is non-empty with zero turns', () => {
    const situation = composeTranscriptSituation({ situation: 'Order a coffee.', turns: [] });
    expect(situation.length).toBeGreaterThan(0);
  });

  // The load-bearing guarantee: whatever this produces must always be
  // acceptable to the existing, unchanged BriefSchema downstream.
  it('always produces something BriefSchema accepts, even near the length cap', () => {
    const turns = Array.from({ length: MAX_INTAKE_TURNS }, (_, i) => ({
      role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
      text: 'x'.repeat(500),
    }));
    const situation = composeTranscriptSituation({ situation: 'a'.repeat(3000), turns });
    expect(BriefSchema.safeParse({ situation }).success).toBe(true);
  });
});

describe('clampSituation', () => {
  it('trims whitespace', () => {
    expect(clampSituation('  hello  ')).toBe('hello');
  });

  it('clamps to 4000 characters', () => {
    const long = 'a'.repeat(5000);
    expect(clampSituation(long).length).toBe(4000);
  });
});
