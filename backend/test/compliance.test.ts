/**
 * Compliance tests.
 *
 * These assert the non-negotiables in docs/compliance.md. They are not ordinary
 * unit tests — a failure here means a real recipient could be called without
 * being told they're talking to an AI. Do not skip, do not soften, do not
 * `.only` around them.
 */

import { describe, expect, it } from 'vitest';

import {
  assertValidDisclosure,
  buildDisclosure,
  DISCLOSURE_ELEMENTS,
} from '../src/domain/disclosure.js';
import { delegateAssistant } from '../src/assistants/delegate.js';
import { interviewAssistant } from '../src/assistants/interview.js';
import type { Intent } from '../src/domain/intent.js';

const intent: Intent = {
  userFirstName: 'Sam',
  recipientName: 'Alex',
  relationship: 'friend',
  situation: 'They fell out after a misunderstanding about a shared lease.',
  feelings: 'Sad, and tired of the silence.',
  pointsToConvey: ['Sam misses them', 'Sam is sorry about how it ended'],
  desiredOutcome: 'Alex agrees to meet up and talk properly.',
  mustSay: ['I should have called sooner'],
  neverSay: ['the money', "Alex's new partner"],
  questionsToAsk: ['Would they be open to meeting?'],
  tone: 'warm',
};

describe('N1/N2 — the disclosure', () => {
  it('contains every required element', () => {
    const disclosure = buildDisclosure('Sam');
    for (const [element, pattern] of Object.entries(DISCLOSURE_ELEMENTS)) {
      expect(pattern.test(disclosure), `missing: ${element}`).toBe(true);
    }
  });

  it('names the user it is acting for', () => {
    expect(buildDisclosure('Sam')).toContain('on behalf of Sam');
  });

  it('refuses to build a weaker disclosure when the name is missing', () => {
    expect(() => buildDisclosure('')).toThrow(/without the user's first name/);
    expect(() => buildDisclosure('   ')).toThrow();
  });

  it('rejects text that drops the AI identification', () => {
    expect(() =>
      assertValidDisclosure(
        "Hi, I'm calling on behalf of Sam — they asked me to help say this. " +
          'Do you want to continue?',
      ),
    ).toThrow(/identifiesAsAI/);
  });

  it('rejects text that drops the consent question', () => {
    expect(() =>
      assertValidDisclosure(
        "Hi, I'm an AI assistant calling on behalf of Sam — they wanted to " +
          'talk to you but asked me to help say this.',
      ),
    ).toThrow(/requestsConsent/);
  });
});

describe('N1 — the disclosure is structural, not prompted', () => {
  const assistant = delegateAssistant(intent, 'https://example.test/webhook');

  it('speaks the disclosure as firstMessage, before the model gets a turn', () => {
    expect(assistant.firstMessage).toBe(buildDisclosure('Sam'));
    expect(assistant.firstMessageMode).toBe('assistant-speaks-first');
  });

  it('exposes no way to override the first message', () => {
    // If someone adds a config path that can replace firstMessage, this is the
    // test that should start failing.
    const keys = Object.keys(assistant);
    expect(keys.filter((k) => /disclos|greeting|intro/i.test(k))).toEqual([]);
  });
});

describe('N5 — boundaries reach the model', () => {
  const assistant = delegateAssistant(intent, 'https://example.test/webhook');
  const prompt = assistant.model.messages[0]!.content;

  it('includes every never-say item', () => {
    for (const forbidden of intent.neverSay) {
      expect(prompt).toContain(forbidden);
    }
  });

  it('states that never-say overrides the desired outcome', () => {
    expect(prompt).toMatch(/the limit wins and the outcome does not happen/);
  });

  it('forbids claiming to be human', () => {
    expect(prompt).toMatch(/never claim to be the user/i);
    expect(prompt).toMatch(/pretend you are human/i);
  });
});

describe('N4 — no outbound calling capability exists', () => {
  it('the Vapi client exposes no call-creation function', async () => {
    const vapi = await import('../src/lib/vapi.js');
    const names = Object.keys(vapi).join(' ').toLowerCase();
    expect(names).not.toMatch(/create|outbound|dial|place/);
  });
});

describe('intent JSON Schema for Vapi extraction', () => {
  it('requires only the fields the user must actually supply', async () => {
    const { intentJsonSchema } = await import('../src/domain/intent.js');
    const schema = intentJsonSchema() as {
      required: string[];
      properties: Record<string, unknown>;
    };

    // Fields with defaults must NOT be required, or the extraction model gets
    // pushed into inventing values for things the user never mentioned.
    expect(schema.required).not.toContain('mustSay');
    expect(schema.required).not.toContain('neverSay');
    expect(schema.required).not.toContain('tone');

    expect(schema.required).toEqual(
      expect.arrayContaining([
        'userFirstName',
        'pointsToConvey',
        'desiredOutcome',
      ]),
    );

    // neverSay still has to exist as an extractable field.
    expect(schema.properties).toHaveProperty('neverSay');
  });
});

describe('handoff carries the intent object', () => {
  const assistant = interviewAssistant('https://example.test/webhook');
  const handoff = assistant.tools.find((t) => t.type === 'handoff')!;
  const destination = (handoff as { destinations: Array<Record<string, unknown>> })
    .destinations[0]!;

  it('extracts intent via variableExtractionPlan', () => {
    expect(destination.variableExtractionPlan).toBeDefined();
  });

  it('does not forward the raw interview transcript to the delegate', () => {
    // A third party is listening once the delegate takes over. It works from
    // the structured intent, not the confidential interview. See ADR-002.
    expect(destination.contextEngineeringPlan).toEqual({ type: 'none' });
  });
});
