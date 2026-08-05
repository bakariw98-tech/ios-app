import { describe, expect, it } from 'vitest';

import { block, screenText } from '../src/domain/safety.js';

describe('hard-block screening', () => {
  it.each([
    ['there is a restraining order against him', 'domestic_violence'],
    ['I am afraid for my safety', 'domestic_violence'],
    ['my daughter is 14 years old', 'minor'],
    ['I need to recover the money he owes me', 'debt_collection'],
    ['I want to talk to their attorney', 'legal_counterparty'],
    ['we have a court date next month', 'legal_counterparty'],
  ])('flags %j as %s', (text, category) => {
    const result = screenText(text);
    expect(result.blocked).toBe(true);
    expect(result.category).toBe(category);
  });

  it('does not flag ordinary difficult conversations', () => {
    const ordinary = [
      "I want to tell my brother I'm not coming to the wedding",
      'I need to apologise to my friend for missing her birthday',
      "I want to tell my dad I'm proud of him before it's too late",
    ];
    for (const text of ordinary) {
      expect(screenText(text).blocked, text).toBe(false);
    }
  });

  it('gives every refusal somewhere to go rather than just saying no', () => {
    const categories = [
      'domestic_violence',
      'minor',
      'debt_collection',
      'legal_counterparty',
    ] as const;

    for (const category of categories) {
      const result = block(category);
      expect(result.spokenRefusal, category).toBeTruthy();
      expect(result.appMessage, category).toBeTruthy();
      // Each refusal points at a human alternative.
      expect(result.spokenRefusal!, category).toMatch(
        /hotline|directly|guardian|your own lawyer|outside what I can do/i,
      );
    }
  });

  it('leads the domestic violence refusal with safety, not policy', () => {
    const refusal = block('domestic_violence').spokenRefusal!;
    expect(refusal).toMatch(/800-799-7233/);
    expect(refusal).not.toMatch(/terms of service|policy|not permitted/i);
  });
});
