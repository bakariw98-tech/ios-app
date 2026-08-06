import { describe, expect, it } from 'vitest';

import {
  BriefSchema,
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

  it('tells the model the user outranks the brief if they jump in', () => {
    const instructions = buildInPersonInstructions({ situation: 'test' });
    expect(instructions).toMatch(/they outrank the brief/i);
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
