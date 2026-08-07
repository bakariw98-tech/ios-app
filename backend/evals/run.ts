#!/usr/bin/env tsx
/**
 * Eval runner. See README.md — this costs real OpenAI usage every run.
 *
 * Reports per-scenario rather than as one pass/fail number, same convention as
 * `e2e/run.mjs`: "held every boundary but never got near the goal" and "reached
 * the goal by conceding a hard limit" are both failures, and they are not the
 * same failure. A single score would hide which one you have.
 *
 *   npx tsx evals/run.ts              # all scenarios
 *   npx tsx evals/run.ts friend-repair family-boundary
 *   EVAL_TRANSCRIPTS=1 npx tsx evals/run.ts friend-repair
 */

import { runScenario, type ScenarioResult } from './harness.js';
import { SCENARIOS } from './scenarios.js';

const RATING_ICON = { good: '✓', partial: '~', poor: '✗' } as const;

function reportOne(result: ScenarioResult): void {
  const { scenario, interview, verdict, turns } = result;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${scenario.id} — ${scenario.title}`);
  console.log('='.repeat(72));

  console.log(`\nInterview: ${interview.questionsAsked} question(s) asked`);
  console.log(`  goal extracted:     ${interview.intent.goal}`);
  console.log(`  compromises:        ${interview.intent.acceptableCompromises.length}`);
  console.log(`  hard limits:        ${interview.intent.hardLimits.length}`);
  console.log(`  never-say:          ${interview.intent.neverSay.length}`);

  // An empty limits list means the interview never drew the boundary out, so a
  // clean boundary result below would be meaningless — the negotiator was
  // never told there was a line. Surfaced here so that can't read as a pass.
  if (
    interview.intent.hardLimits.length === 0 &&
    interview.intent.neverSay.length === 0
  ) {
    console.log(
      '  ⚠ no limits captured — boundary results below prove nothing',
    );
  }

  console.log(`\nConversation: ${turns.length} turns`);
  console.log(
    `  ${verdict.disclosedForbidden ? '✗' : '✓'} kept forbidden subjects out` +
      `${verdict.disclosedForbidden ? ` — ${verdict.disclosedEvidence}` : ''}`,
  );
  console.log(
    `  ${verdict.concededForbidden ? '✗' : '✓'} held every hard limit` +
      `${verdict.concededForbidden ? ` — ${verdict.concededEvidence}` : ''}`,
  );
  console.log(
    `  ${verdict.invented ? '✗' : '✓'} invented nothing` +
      `${verdict.invented ? ` — ${verdict.inventedEvidence}` : ''}`,
  );
  console.log(`  ${RATING_ICON[verdict.pursuedGoal]} pursued the goal — ${verdict.pursuedGoalEvidence}`);
  console.log(`  ${RATING_ICON[verdict.adapted]} adapted vs repeated — ${verdict.adaptedEvidence}`);
  console.log(`  ${RATING_ICON[verdict.escalation]} escalation judgement — ${verdict.escalationEvidence}`);
  console.log(`\n  notes: ${verdict.notes}`);

  if (process.env.EVAL_TRANSCRIPTS) {
    console.log('\n--- transcript ---');
    for (const turn of turns) {
      const who =
        turn.speaker === 'ai'
          ? `AI(${scenario.userFirstName})`
          : turn.speaker === 'user'
            ? `${scenario.userFirstName}[typed]`
            : scenario.counterpart.name;
      console.log(`\n${who}: ${turn.text}`);
    }
  }
}

/** A boundary breach is disqualifying on its own; the rated criteria are quality. */
function isFailure(result: ScenarioResult): boolean {
  const v = result.verdict;
  return (
    v.disclosedForbidden ||
    v.concededForbidden ||
    v.invented ||
    v.pursuedGoal === 'poor' ||
    v.adapted === 'poor' ||
    v.escalation === 'poor'
  );
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set — see evals/README.md');
    process.exitCode = 1;
    return;
  }

  const requested = process.argv.slice(2);
  const scenarios = requested.length
    ? SCENARIOS.filter((s) => requested.includes(s.id))
    : SCENARIOS;

  if (!scenarios.length) {
    console.error(
      `No scenario matched. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Running ${scenarios.length} scenario(s)\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  running ${scenario.id}...`);
    try {
      const result = await runScenario(scenario);
      results.push(result);
      process.stdout.write(' done\n');
    } catch (error) {
      process.stdout.write(' FAILED\n');
      console.error(`  ${scenario.id} threw:`, error);
    }
  }

  for (const result of results) reportOne(result);

  console.log(`\n${'='.repeat(72)}`);
  console.log('Summary');
  console.log('='.repeat(72));
  for (const result of results) {
    const v = result.verdict;
    const flags = [
      v.disclosedForbidden ? 'DISCLOSED' : null,
      v.concededForbidden ? 'CONCEDED' : null,
      v.invented ? 'INVENTED' : null,
    ].filter(Boolean);
    console.log(
      `  ${isFailure(result) ? '✗' : '✓'} ${result.scenario.id.padEnd(26)} ` +
        `goal:${v.pursuedGoal.padEnd(8)} adapt:${v.adapted.padEnd(8)} ` +
        `escal:${v.escalation.padEnd(8)} ${flags.join(' ')}`,
    );
  }

  const failed = results.filter(isFailure).length;
  const errored = scenarios.length - results.length;
  console.log(
    `\n${results.length - failed}/${results.length} scenarios clean` +
      (errored ? `, ${errored} errored before producing a verdict` : ''),
  );

  process.exitCode = failed > 0 || errored > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exitCode = 1;
});
