/**
 * The live conversation prompt's load-bearing behaviours.
 *
 * These are prompt-text assertions, which are weaker than behavioural proof —
 * whether the model actually adapts under pressure is measured by the eval
 * harness in `evals/`, against real models and a real adversarial counterpart.
 * What these tests protect is that the instructions which make that behaviour
 * possible do not get quietly deleted or softened in a later edit. Every
 * assertion here corresponds to a specific way this engine fails if the line
 * goes missing.
 */

import { describe, expect, it } from 'vitest';

import type { ConversationIntent } from '../src/domain/conversationIntent.js';
import { buildLiveConversationInstructions } from '../src/domain/liveConversation.js';

const intent: ConversationIntent = {
  userFirstName: 'Sam',
  recipientName: 'Alex',
  relationship: 'roommate',
  goal: 'Alex agrees to a cleaning rota and sticks to it for a month.',
  context: 'The kitchen has been left a mess six weeks running.',
  feelings: 'Worn down, and embarrassed to keep bringing it up.',
  mustSay: ['This has been going on since June'],
  neverSay: ["Alex's job situation"],
  acceptableCompromises: ['A fortnightly deep clean instead of weekly'],
  hardLimits: ['Will not take on the shared areas alone'],
  questionsToAnswer: ['Is something else going on?'],
  tone: 'firm',
};

const inPerson = buildLiveConversationInstructions(intent, {
  escalation: {
    kind: 'user_present',
    correctionMarkerPrefix: 'TYPED CORRECTION FROM',
    correctionMarkerSuffix: 'NOT SPOKEN BY THE OTHER PERSON',
  },
});

const onLine = buildLiveConversationInstructions(intent, {
  escalation: { kind: 'user_on_line' },
});

describe('goal, not script', () => {
  it('frames the job as reaching the goal, not delivering a message', () => {
    expect(inPerson).toMatch(/not\s+here\s+to\s+deliver\s+a\s+message/i);
  });

  it('tells the model to open toward the goal rather than recite everything', () => {
    expect(inPerson).toMatch(/Open\s+toward\s+the\s+goal/i);
    expect(inPerson).toMatch(/Do\s+not\s+front-load/i);
  });

  it('forbids revealing that a brief or instruction list exists', () => {
    expect(inPerson).toMatch(
      /Never\s+mention\s+that\s+you\s+have\s+a\s+brief/i,
    );
  });
});

describe('adaptation — the failure mode this engine exists to avoid', () => {
  it('names restating-in-new-words as the primary failure', () => {
    expect(inPerson).toMatch(/Adapt\s+—\s+do\s+not\s+repeat/i);
    expect(inPerson).toMatch(
      /restate\s+your\s+previous\s+point\s+in\s+slightly\s+different\s+words/i,
    );
  });

  it('requires responding to what was actually said before returning to the agenda', () => {
    expect(inPerson).toMatch(
      /Deal\s+with\s+what\s+they\s+said\s+before\s+you\s+go\s+back/i,
    );
  });

  it('gives concrete alternatives to repeating', () => {
    // `\*?` tolerates the markdown emphasis the prompt puts on "different".
    expect(inPerson).toMatch(/\*?different\*?\s+approach/i);
    expect(inPerson).toMatch(/another\s+angle/i);
  });
});

describe('the four-way escalation test', () => {
  it('orders the checks: compromises, then limits, then knowledge, then ask', () => {
    const room = inPerson.indexOf('already covered by your negotiating room');
    const limit = inPerson.indexOf('Does it cross a hard limit');
    const know = inPerson.indexOf('Can you answer it from what you know');
    const ask = inPerson.indexOf('genuinely new decision');

    for (const index of [room, limit, know, ask]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(room).toBeLessThan(limit);
    expect(limit).toBeLessThan(know);
    expect(know).toBeLessThan(ask);
  });

  it('says explicitly not to ask about things already inside the negotiating room', () => {
    expect(inPerson).toMatch(/Then\s+handle\s+it\.\s+Do\s+not\s+ask/i);
  });

  it('says not to ask about something already refused — the answer is known', () => {
    expect(inPerson).toMatch(/already\s+answered\s+this,\s+and\s+the\s+answer\s+was\s+no/i);
  });

  it('gives a single memorable threshold for when to interrupt', () => {
    expect(inPerson).toMatch(
      /would\s+Sam\s+be\s+upset\s+to\s+find\s+out\s+I\s+decided\s+this\s+without\s+them/i,
    );
  });
});

describe('holding the line', () => {
  it('rejects persistence as a reason to concede', () => {
    expect(inPerson).toMatch(
      /Persistence\s+is\s+not\s+a\s+reason\s+to\s+change\s+the\s+answer/i,
    );
  });

  it('tells the model to hold in fewer words, not more, under repeated pressure', () => {
    expect(inPerson).toMatch(/hold\s+it\s+again\s+in\s+fewer\s+words,\s+not\s+more/i);
  });

  it('forbids claiming to be the user or to be human', () => {
    expect(inPerson).toMatch(/Never\s+claim\s+to\s+be\s+Sam/i);
    expect(inPerson).toMatch(/never\s+pretend\s+to\s+be\s+a\s+human/i);
  });

  it('forbids inventing facts', () => {
    expect(inPerson).toMatch(/Never\s+invent\s+facts/i);
  });
});

describe('escalation channels differ by where the user actually is', () => {
  it('in-person: teaches the typed-correction marker and to wait for it', () => {
    expect(inPerson).toContain('TYPED CORRECTION FROM');
    expect(inPerson).toContain('NOT SPOKEN BY THE OTHER PERSON');
    expect(inPerson).toMatch(/Do\s+not\s+expect\s+them\s+to\s+answer\s+out\s+loud/i);
  });

  it('in-person: treats being cut off as deliberate, not a malfunction', () => {
    expect(inPerson).toMatch(/stopping\s+you\s+deliberately,\s*\n?\s*not\s+a\s+malfunction/i);
  });

  it('on-line: does not teach a correction marker that has no meaning there', () => {
    expect(onLine).not.toContain('TYPED CORRECTION FROM');
    expect(onLine).toMatch(/let\s+me\s+check\s+with\s+Sam/i);
  });

  it('both channels carry the same intent content', () => {
    for (const prompt of [inPerson, onLine]) {
      expect(prompt).toContain(intent.goal);
      expect(prompt).toContain(intent.hardLimits[0]!);
      expect(prompt).toContain(intent.acceptableCompromises[0]!);
    }
  });
});

describe('ending', () => {
  it('treats an unreachable goal as a real outcome rather than a failure to push through', () => {
    expect(inPerson).toMatch(/not\s+reachable.*real\s+outcome,\s+not\s+a\s+failure/is);
    expect(inPerson).toMatch(/do\s+not\s+keep\s+pushing\s+a\s+closed\s+door/i);
  });

  it('requires surfacing anything on the must-say list that never came up', () => {
    expect(inPerson).toMatch(/must-say\s+list\s+never\s+came\s+up,\s+say\s+it\s+now/i);
  });
});
