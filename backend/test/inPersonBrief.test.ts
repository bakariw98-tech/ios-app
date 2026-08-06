import { describe, expect, it } from 'vitest';

import {
  BriefSchema,
  CORRECTION_MARKER_PREFIX,
  CORRECTION_MARKER_SUFFIX,
  buildInPersonInstructions,
} from '../src/domain/inPersonBrief.js';

describe('BriefSchema', () => {
  it('accepts a minimal brief with just a situation', () => {
    const result = BriefSchema.safeParse({
      situation: 'Order a McDouble, no pickles, and a water.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty situation', () => {
    expect(BriefSchema.safeParse({ situation: '' }).success).toBe(false);
  });

  it('rejects a missing situation entirely', () => {
    expect(BriefSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an optional userFirstName', () => {
    const result = BriefSchema.safeParse({
      situation: 'Ask for a refund on the late delivery.',
      userFirstName: 'Sam',
    });
    expect(result.success).toBe(true);
  });
});

describe('buildInPersonInstructions', () => {
  it('includes the situation verbatim', () => {
    const instructions = buildInPersonInstructions({
      situation: 'Order a McDouble, no pickles, and a water.',
    });
    expect(instructions).toContain('Order a McDouble, no pickles, and a water.');
  });

  it('tells the model everyone present hears everything', () => {
    const instructions = buildInPersonInstructions({
      situation: 'test',
    });
    expect(instructions).toMatch(/everyone present/i);
    expect(instructions).toMatch(/hears[\s\n]+everything/i);
    expect(instructions).toMatch(/not on a phone call/i);
  });

  it('forbids inventing facts not in the brief', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/don't invent details/i);
  });

  it('instructs escalating real decisions back to the user by name', () => {
    const instructions = buildInPersonInstructions({
      situation: 'test',
      userFirstName: 'Sam',
    });
    expect(instructions).toContain('Sam');
    expect(instructions).toMatch(/stop and ask Sam directly/i);
  });

  it('falls back to a generic address when no name is given', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/the person you are with/i);
  });

  // This is the correction to the flawed initial assumption: the target
  // population (severe stutter, apraxia, ALS, non-verbal autism, selective
  // mutism) often cannot reliably produce live speech, which is the entire
  // reason they're using this mode. "They'll jump in verbally" is not a
  // safe fallback, so the prompt must not lean on it.
  it('does not assume the user can verbally interrupt', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/may not be able to reliably speak/i);
    expect(instructions).toMatch(/don't wait for them to jump in[\s\n]+verbally/i);
  });

  it('teaches the model the exact typed-correction marker format', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toContain(CORRECTION_MARKER_PREFIX);
    expect(instructions).toContain(CORRECTION_MARKER_SUFFIX);
    expect(instructions).toMatch(/full authority/i);
    expect(instructions).toMatch(/never[\s\n]+read the bracket.*out loud/i);
  });

  it('tells the model being cut off mid-sentence is normal, not an error', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/cut off mid-sentence/i);
    expect(instructions).toMatch(/not a technical error/i);
  });

  it('instructs a confident, non-hedging delivery', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/confident/i);
    expect(instructions).toMatch(/hedge, mumble, or undersell/i);
  });

  // Real-world feedback: the model was front-loading every part of a
  // multi-part brief into one opening statement instead of raising things
  // conversationally, one at a time, the way a person actually would. This
  // locks in the fix so it can't silently regress.
  it('instructs pacing a multi-part brief across turns, not one opening dump', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/more than one\s+conversational beat/i);
    expect(instructions).toMatch(/open with the single most important\s+part/i);
    expect(instructions).toMatch(/do not front-load/i);
    expect(instructions).toMatch(/summarizes or lists every point.*at once/i);
  });

  // This is the one property that most needs to hold: this mode has no
  // interview, no consent gate, no merge window — it must never assume one
  // exists. A stray reference to disclosure/consent here would mean someone
  // copy-pasted phone-mode language into the wrong prompt.
  it('never mentions the phone-mode disclosure or consent machinery', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).not.toMatch(/on behalf of.*they wanted to talk/i);
    expect(instructions).not.toMatch(/do you want to continue/i);
    expect(instructions).not.toMatch(/merge window/i);
  });
});
