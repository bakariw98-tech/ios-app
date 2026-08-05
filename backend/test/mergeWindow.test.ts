/**
 * Merge-window tests.
 *
 * The property under test throughout is the asymmetry: every uncertain case
 * must resolve toward disclosing early, never toward staying quiet. A test here
 * that starts failing in the "too eager" direction is a nuisance; one that fails
 * in the "too slow" direction is a recipient hearing something private.
 */

import { describe, expect, it } from 'vitest';

import {
  MERGE_WINDOW_RULES,
  looksLikeNewParty,
  violatesQuietMode,
} from '../src/domain/mergeWindow.js';
import { interviewAssistant } from '../src/assistants/interview.js';

describe('detecting a new party', () => {
  it.each([
    'Hello?',
    'hello',
    'Hi?',
    "Who's this?",
    'Who is that?',
    'This is Alex.',
    'Yeah?',
  ])('flags %j as someone picking up', (utterance) => {
    expect(looksLikeNewParty(utterance)).toBe(true);
  });

  it('does not flag ordinary interview speech', () => {
    const interviewSpeech = [
      "I want to tell him I'm sorry about how it ended",
      "Hello, I've been meaning to do this for months",
      'Yeah, that sounds about right to me',
      "I don't want you to bring up the money",
    ];
    for (const utterance of interviewSpeech) {
      expect(looksLikeNewParty(utterance), utterance).toBe(false);
    }
  });
});

describe('quiet mode tripwire', () => {
  it('allows short merge coaching', () => {
    const coaching = [
      'Tap Add Call — I’ll still be here.',
      'Now dial them and wait for them to pick up.',
      'Take your time.',
      "I'm still here.",
      'Now tap Merge Calls.',
    ];
    for (const utterance of coaching) {
      expect(violatesQuietMode(utterance), utterance).toBe(false);
    }
  });

  it('trips on the assistant recapping the plan', () => {
    expect(
      violatesQuietMode("So I'll tell them you've been thinking about them."),
    ).toBe(true);
    expect(violatesQuietMode('To recap, the plan is to apologise first.')).toBe(
      true,
    );
    expect(violatesQuietMode('As we discussed, you want him to know.')).toBe(
      true,
    );
  });

  it('trips on any long utterance during the window', () => {
    // Coaching is short by nature. Length is a decent proxy for "the assistant
    // has gone back to the substance of the interview".
    const longTurn =
      'I want to make sure I have this right before they join, because you ' +
      'mentioned a few different things and I want to be careful about which ' +
      'ones you actually want raised and which ones you would rather I left ' +
      'alone entirely.';
    expect(violatesQuietMode(longTurn)).toBe(true);
  });
});

describe('the prompt encodes the safe default', () => {
  it('tells the model to assume it is already overheard', () => {
    expect(MERGE_WINDOW_RULES).toMatch(
      /assume the other person can already hear you/i,
    );
  });

  it('instructs handoff under uncertainty', () => {
    expect(MERGE_WINDOW_RULES).toMatch(
      /you are not sure whether someone new is on the line/i,
    );
  });

  it('forbids discussing the situation during the window', () => {
    expect(MERGE_WINDOW_RULES).toMatch(/may \*\*not\*\* say anything about/i);
  });

  it('forbids greeting the recipient before handing off', () => {
    expect(MERGE_WINDOW_RULES).toMatch(/do not greet the other person yourself/i);
  });
});

describe('interview assistant wiring', () => {
  const assistant = interviewAssistant('https://example.test/webhook');
  const toolNames = assistant.tools.map((t) =>
    'function' in t ? t.function.name : t.type,
  );

  it('exposes arm and cancel alongside the handoff', () => {
    expect(toolNames).toContain('arm_for_merge');
    expect(toolNames).toContain('cancel_merge');
    expect(toolNames).toContain('begin_delegation');
  });

  it('requires the user first name when arming, so the backstop can speak', () => {
    const arm = assistant.tools.find(
      (t) => 'function' in t && t.function.name === 'arm_for_merge',
    )!;
    const params = (arm as { function: { parameters: { required: string[] } } })
      .function.parameters;
    expect(params.required).toContain('userFirstName');
  });

  it('tells the model to hand off when unsure', () => {
    const description = (
      assistant.tools.find(
        (t) => 'function' in t && t.function.name === 'begin_delegation',
      ) as { function: { description: string } }
    ).function.description;
    expect(description).toMatch(/when in doubt, call it/i);
  });
});
