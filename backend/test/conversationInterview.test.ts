/**
 * The interview's guarantees.
 *
 * The most important assertion in this file is the one about the question the
 * interview must never ask. "What do you want me to say?" produces a script,
 * and a script is the thing this entire engine exists not to be — so it is
 * pinned here as a prohibition, in the prompt, permanently.
 */

import { describe, expect, it } from 'vitest';

import {
  FINISH_INTERVIEW_TOOL,
  INTERVIEW_REPLY_JSON_SCHEMA,
  InterviewReplySchema,
  InterviewRequestSchema,
  MAX_INTERVIEW_QUESTIONS,
  MAX_INTERVIEW_TURNS,
  MAX_SPOKEN_TURNS,
  SpokenTranscriptSchema,
  buildExtractionInstructions,
  buildExtractionMessages,
  buildFinalizeNudgeMessage,
  buildInterviewInstructions,
  buildInterviewMessages,
  buildSpokenExtractionMessages,
  buildSpokenInterviewInstructions,
  normalizeInterviewReply,
} from '../src/domain/conversationInterview.js';

const prompt = buildInterviewInstructions({ userFirstName: 'Sam' });
const spoken = buildSpokenInterviewInstructions({ userFirstName: 'Sam' });
const extraction = buildExtractionInstructions();

describe('reply schema stays in sync and strict-mode-valid', () => {
  it('describes exactly the zod schema fields, all required', () => {
    const zodKeys = Object.keys(InterviewReplySchema.shape).sort();
    expect(Object.keys(INTERVIEW_REPLY_JSON_SCHEMA.properties).sort()).toEqual(
      zodKeys,
    );
    expect([...INTERVIEW_REPLY_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
    expect(INTERVIEW_REPLY_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('expresses the optional question as nullable, not omitted', () => {
    // Strict mode has no optional properties — "no question this turn" has to
    // be null, not a missing key. Getting this wrong is a live 400.
    expect(INTERVIEW_REPLY_JSON_SCHEMA.properties.question.type).toEqual([
      'string',
      'null',
    ]);
  });
});

describe('normalizeInterviewReply', () => {
  it('accepts a question turn', () => {
    expect(
      normalizeInterviewReply({ done: false, question: 'What happened?' }),
    ).toEqual({ kind: 'question', question: 'What happened?' });
  });

  it('accepts a done turn and ignores any question alongside it', () => {
    expect(normalizeInterviewReply({ done: true, question: null })).toEqual({
      kind: 'done',
    });
  });

  it('throws on the incoherent combination rather than passing it downstream', () => {
    expect(() =>
      normalizeInterviewReply({ done: false, question: null }),
    ).toThrow(/not done but returned no question/);
  });
});

describe('the question that must never be asked', () => {
  it('forbids "what do you want me to say" explicitly', () => {
    expect(prompt).toMatch(/question\s+you\s+must\s+never\s+ask/i);
    expect(prompt).toContain('"What do you want me to say?"');
  });

  it('explains why — a script is worthless on the unexpected turn', () => {
    expect(prompt).toMatch(/gets\s+you\s+a\s+script/i);
    expect(prompt).toMatch(/not\s+collecting\s+sentences\s+to\s+be\s+read\s+out/i);
  });
});

describe('the six things the interview extracts', () => {
  it('asks for the goal as an outcome, not a topic', () => {
    expect(prompt).toMatch(/what\s+they\s+want\s+to\s+walk\s+away\s+WITH/i);
  });

  it('anticipates that people answer the goal question with a topic, and pushes once', () => {
    expect(prompt).toMatch(/rather\s+than\s+an\s+outcome/i);
    expect(prompt).toMatch(/pushing\s+a\s+third\s+time/i);
  });

  it('requires the hard-line question to be asked every time, unprompted', () => {
    expect(prompt).toMatch(/Ask\s+this\s+outright,\s+every\s+single\s+time/i);
    expect(prompt).toMatch(/nobody\s+volunteers\s+the\s+answer\s+to/i);
  });

  it('forbids asking about compromise abstractly, and demands a grounded hypothetical', () => {
    expect(prompt).toMatch(/Never\s+ask\s+this\s+abstractly/i);
    expect(prompt).toMatch(/specific\s+hypothetical/i);
  });

  it('covers backstory, questions-to-answer, and tone', () => {
    expect(prompt).toMatch(/What\s+actually\s+happened/i);
    expect(prompt).toMatch(/What\s+they\s+want\s+to\s+know/i);
    expect(prompt).toMatch(/Tone/i);
  });

  it('tells it not to spend a question on tone it can infer', () => {
    expect(prompt).toMatch(/Do\s+not\s+spend\s+a\s+question\s+on\s+this/i);
  });
});

describe('not therapy', () => {
  it('forbids advice and deflects the request for it', () => {
    expect(prompt).toMatch(/Never\s+give\s+advice/i);
    expect(prompt).toMatch(/What\s+would\s+you\s+want\s+them\s+to\s+understand/i);
  });

  it('forbids reframing the user\'s account of what happened', () => {
    expect(prompt).toMatch(/Never\s+reframe\s+what\s+happened/i);
    expect(prompt).toMatch(/framing.*AI\s+will\s+carry\s+into\s+the\s+room/is);
  });

  it('forbids judging the other person and naming unnamed emotions', () => {
    expect(prompt).toMatch(/Never\s+judge\s+the\s+other\s+person/i);
    expect(prompt).toMatch(/emotions\s+they\s+did\s+not\s+name/i);
  });
});

describe('question discipline', () => {
  it('enforces one question per turn', () => {
    expect(prompt).toMatch(/Exactly\s+ONE\s+question\s+per\s+turn/i);
  });

  it('states the cap using the exported constant, so the two cannot drift', () => {
    expect(prompt).toContain(String(MAX_INTERVIEW_QUESTIONS));
  });

  it('stops immediately when the user says go', () => {
    expect(prompt).toMatch(/stop\s+immediately,\s+whatever\s+you\s+still\s+don't\s+know/i);
  });

  it('refuses to finish without the compromise room', () => {
    // Regression guard for a real failure caught on a live run: with a vaguer
    // stop condition ("you could brief someone cold"), the interview finished
    // after three questions having captured the goal and both limits but an
    // EMPTY acceptableCompromises. That is not a short interview, it is a
    // failed one — an intent with no negotiating room degrades the negotiator
    // back into the relay this engine exists to replace, since it can then
    // only restate its position or interrupt the user.
    expect(prompt).toMatch(/Three\s+things\s+are\s+non-negotiable/i);
    expect(prompt).toMatch(/The\s+room\s+to\s+move/i);
    expect(prompt).toMatch(
      /Getting\s+the\s+goal\s+and\s+the\s+limits\s+but\s+no\s+room\s+to\s+move\s+is\s+not\s+a\s+short\s+interview,\s+it\s+is\s+a\s+failed\s+one/i,
    );
  });

  it('explains what an empty compromise room costs, not just that it is required', () => {
    expect(prompt).toMatch(/only\s+restate\s+its\s+opening\s+position/i);
  });

  it('derives the turn cap from the question cap', () => {
    expect(MAX_INTERVIEW_TURNS).toBe(MAX_INTERVIEW_QUESTIONS * 2);
  });
});

describe('extraction prompt sorts the three kinds of limit correctly', () => {
  it('distinguishes doing, discussing, and conceding', () => {
    expect(extraction).toMatch(
      /refusal\s+to\s+\*?do\*?\s+something\s+is\s+a\s+hard\s+limit/i,
    );
    expect(extraction).toMatch(
      /refusal\s+to\s+\*?discuss\*?\s+something\s+is\s+a\s+never-say/i,
    );
    expect(extraction).toMatch(/reluctantly\s+accept\s+is\s+a\s+compromise/i);
  });

  it('names mixing them up as the most damaging mistake', () => {
    expect(extraction).toMatch(/most\s+damaging\s+mistake/i);
  });

  it('routes hypothetical acceptances into the negotiating room', () => {
    expect(extraction).toMatch(/agreed\s+to\s+in\s+a\s+hypothetical/i);
  });

  it('prefers an empty field over a plausible invention', () => {
    expect(extraction).toMatch(/empty\s+field\s+is\s+correct\s+and\s+safe/i);
    expect(extraction).toMatch(/Only\s+what\s+they\s+said/i);
  });

  it('restates goal-not-topic at extraction time, with a worked example', () => {
    expect(extraction).toMatch(/goal\s+is\s+an\s+outcome,\s+not\s+a\s+topic/i);
    expect(extraction).toMatch(/is\s+a\s+topic/i);
    expect(extraction).toMatch(/is\s+a\s+goal/i);
  });

  it('limits inference to exactly the two fields that need it', () => {
    expect(extraction).toMatch(
      /only\s+fields\s+you\s+should\s+infer\s+rather\s+than\s+quote/i,
    );
  });
});

describe('message assembly', () => {
  const request = InterviewRequestSchema.parse({
    situation: 'I need to talk to my sister about Christmas.',
    userFirstName: 'Sam',
    turns: [
      { role: 'assistant', text: 'What would make this worth having?' },
      { role: 'user', text: 'I want her to admit she was out of line.' },
    ],
  });

  it('puts the system prompt first and the opening message as the first user turn', () => {
    const messages = buildInterviewMessages(request);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: request.situation });
  });

  it('replays interview turns in order and in role', () => {
    const messages = buildInterviewMessages(request);
    expect(messages.slice(2)).toEqual([
      { role: 'assistant', content: 'What would make this worth having?' },
      { role: 'user', content: 'I want her to admit she was out of line.' },
    ]);
  });

  it('flattens the transcript for extraction instead of replaying roles', () => {
    // Replaying real user/assistant roles invites the extraction model to
    // continue the interview rather than summarise it.
    const messages = buildExtractionMessages(request);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('They opened with:');
    expect(messages[1]!.content).toContain('Interviewer asked:');
    expect(messages[1]!.content).toContain('They answered:');
    expect(messages[1]!.content).toContain('Their first name is Sam.');
  });

  it('omits the name line entirely when no name was given', () => {
    const anon = InterviewRequestSchema.parse({ situation: 'Something hard.' });
    expect(buildExtractionMessages(anon)[1]!.content).not.toMatch(
      /first\s+name\s+is/i,
    );
  });

  it('caps the turns array so an oversized request never reaches OpenAI', () => {
    const tooMany = Array.from({ length: MAX_INTERVIEW_TURNS + 2 }, () => ({
      role: 'user' as const,
      text: 'x',
    }));
    expect(
      InterviewRequestSchema.safeParse({ situation: 'hi', turns: tooMany })
        .success,
    ).toBe(false);
  });

  it('nudges toward finalizing without offering another question', () => {
    const nudge = buildFinalizeNudgeMessage();
    expect(nudge.role).toBe('system');
    expect(nudge.content).toMatch(/Do\s+not\s+ask\s+anything\s+else/i);
  });
});

describe('the spoken interview shares its substance with the typed one', () => {
  // The two prompts differ only in medium and in how they signal they're
  // finished. Everything that determines interview QUALITY is shared via
  // interviewCore(), because two hand-maintained copies would drift within a
  // week — and silently, since both would still produce plausible interviews,
  // just different ones. These assertions are what makes that structural.
  const sharedSubstance = [
    /question\s+you\s+must\s+never\s+ask/i,
    /gets\s+you\s+a\s+script/i,
    /what\s+they\s+want\s+to\s+walk\s+away\s+WITH/i,
    /Ask\s+this\s+outright,\s+every\s+single\s+time/i,
    /Never\s+ask\s+this\s+abstractly/i,
    /specific\s+hypothetical/i,
    /Never\s+give\s+advice/i,
    /Never\s+reframe\s+what\s+happened/i,
    /Three\s+things\s+are\s+non-negotiable/i,
    /The\s+room\s+to\s+move/i,
    /it\s+is\s+a\s+failed\s+one/i,
  ];

  for (const pattern of sharedSubstance) {
    it(`both carry ${pattern}`, () => {
      expect(prompt).toMatch(pattern);
      expect(spoken).toMatch(pattern);
    });
  }

  it('both forbid the same question verbatim', () => {
    expect(prompt).toContain('"What do you want me to say?"');
    expect(spoken).toContain('"What do you want me to say?"');
  });
});

describe('the spoken interview differs only where the medium demands', () => {
  it('tells the typed one it is typed and the spoken one it is spoken', () => {
    expect(prompt).toMatch(/is\s+typing\s+to\s+you/i);
    expect(spoken).toMatch(/This\s+is\s+a\s+spoken\s+conversation/i);
  });

  it('finishes via a flag when typed and a tool call when spoken', () => {
    expect(prompt).toMatch(/Set\s+done\s+to\s+true/i);
    expect(prompt).not.toMatch(/finish_interview/);
    expect(spoken).toMatch(/call\s+the\s+finish_interview\s+tool/i);
    expect(spoken).not.toMatch(/Set\s+done\s+to\s+true/i);
  });

  it('carries voice-specific guidance the typed one has no need for', () => {
    expect(spoken).toMatch(/Keep\s+questions\s+SHORT/i);
    expect(spoken).toMatch(/Let\s+them\s+ramble/i);
    // A spoken question can't be re-read — the reason brevity matters more here.
    expect(spoken).toMatch(/cannot\s+be\s+re-read|written\s+question\s+can\s+be\s+re-read/i);
    expect(prompt).not.toMatch(/Let\s+them\s+ramble/i);
  });

  it('forbids the spoken one from narrating the machinery out loud', () => {
    expect(spoken).toMatch(/Never\s+mention\s+tools,\s+briefs,\s+fields/i);
    expect(spoken).toMatch(/never\s+number\s+your\s+questions\s+out\s+loud/i);
  });

  it('has it speak a closing line before calling the tool, not after', () => {
    // Calling the tool first would cut the session dead mid-silence, which
    // reads as a crash rather than an ending.
    expect(spoken).toMatch(/closing\s+line\s+out\s+loud.*then\s+call/is);
  });
});

describe('FINISH_INTERVIEW_TOOL', () => {
  it('is a zero-argument function tool', () => {
    expect(FINISH_INTERVIEW_TOOL.type).toBe('function');
    expect(FINISH_INTERVIEW_TOOL.name).toBe('finish_interview');
    expect(FINISH_INTERVIEW_TOOL.parameters.properties).toEqual({});
    expect(FINISH_INTERVIEW_TOOL.parameters.required).toEqual([]);
  });

  it('tells the model to call it when the person says they are done too', () => {
    expect(FINISH_INTERVIEW_TOOL.description).toMatch(/says\s+they\s+are\s+done/i);
  });
});

describe('spoken transcript extraction', () => {
  const transcript = {
    userFirstName: 'Sam',
    turns: [
      { role: 'assistant' as const, text: "What's going on?" },
      { role: 'user' as const, text: 'I need to talk to my sister.' },
    ],
  };

  it('reuses the typed extraction instructions unchanged', () => {
    // The extraction prompt is about reading a finished interview and sorting
    // what it finds — nothing about it is modality-specific, so a second copy
    // would be pure drift risk.
    const messages = buildSpokenExtractionMessages(transcript);
    expect(messages[0]!.content).toBe(buildExtractionInstructions());
  });

  it('flattens the transcript and warns the model about speech artefacts', () => {
    const messages = buildSpokenExtractionMessages(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toMatch(/spoken\s+out\s+loud\s+and\s+transcribed/i);
    expect(messages[1]!.content).toMatch(/false\s+starts\s+and\s+filler/i);
    expect(messages[1]!.content).toContain('Interviewer asked:');
    expect(messages[1]!.content).toContain('They said:');
    expect(messages[1]!.content).toContain('Their first name is Sam.');
  });

  it('requires at least one turn — an empty transcript has nothing to extract', () => {
    expect(SpokenTranscriptSchema.safeParse({ turns: [] }).success).toBe(false);
  });

  it('caps turns well above the typed cap, since speech has no Q/A rhythm', () => {
    expect(MAX_SPOKEN_TURNS).toBeGreaterThan(MAX_INTERVIEW_TURNS);
    const tooMany = Array.from({ length: MAX_SPOKEN_TURNS + 1 }, () => ({
      role: 'user' as const,
      text: 'x',
    }));
    expect(SpokenTranscriptSchema.safeParse({ turns: tooMany }).success).toBe(false);
  });
});
