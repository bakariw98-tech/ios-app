/**
 * N4 (docs/compliance.md) is a legal constraint, not a technical one: our
 * server must never place an outbound call to the recipient, because our
 * verbal consent only ever happens after the recipient answers a call *the
 * user* placed. That was true under Vapi (which never offered the
 * capability at all — ADR-001 designed around the gap) and stays true under
 * Twilio, which genuinely *can* dial someone with one HTTP call. This test
 * makes that boundary mechanical rather than aspirational: it greps the
 * entire source tree for the exact endpoint shapes that would violate it,
 * and fails the build if any of them ever appear outside this file's own
 * allowlist comment.
 *
 * Direct analogue of web.test.ts's correctionMarker containment guard —
 * same idea (a real code change could reintroduce the risk silently; a grep
 * assertion catches it at test time instead of at a live call).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', 'src');

// This file's own path is excluded below by name, since it necessarily
// quotes these strings to describe what it's forbidding.
const SELF = join(__dirname, 'noOutboundDialing.test.ts');

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strips `/** ... *\/`-style block comments before matching. lib/twilio.ts's
 * own warning comment necessarily quotes the forbidden endpoint strings to
 * explain what not to do — this test is about catching those strings
 * reachable as *code*, not catching a comment that warns against them. Line
 * comments (`//`) are deliberately left alone: naively truncating at the
 * first `//` on a line would also truncate `https://...` inside an ordinary
 * string literal, which could hide a real violation instead of catching one
 * — the opposite of what this test exists to do.
 */
function stripBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readAllSource(): Array<{ path: string; content: string }> {
  return collectFiles(SRC_ROOT)
    .filter((path) => path !== SELF)
    .map((path) => ({ path, content: stripBlockComments(readFileSync(path, 'utf-8')) }));
}

// The two exact endpoint shapes confirmed (Twilio docs MCP, this session) to
// be capable of originating a call to a third party. Everything else in
// lib/twilio.ts — signature verification, TwiML generation, ending a call
// already in progress — deliberately can't reach these.
const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'Conference Participants API (dials a participant into a call)',
    pattern: /Participants\.json/,
  },
  {
    name: 'Conferences resource (paired with Participants to dial in)',
    pattern: /Conferences\//,
  },
  {
    name: 'a POST to Calls.json that is not this repo\'s own endCall (ending, not creating)',
    // endCall's only call is `POST .../Calls/${callSid}.json` with an
    // existing CallSid interpolated in — never a bare `Calls.json` create.
    pattern: /\/Calls\.json/,
  },
];

describe('N4 — no outbound-dialing capability exists anywhere in src/', () => {
  const files = readAllSource();

  it('scanned at least the expected number of source files (sanity check on the scan itself)', () => {
    // If this drops near zero, the scan is broken (wrong root, wrong
    // extension filter) and every other assertion in this file is vacuous.
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    it(`no file contains ${name}`, () => {
      const offenders = files
        .filter(({ content }) => pattern.test(content))
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
    });
  }

  it('the Vapi client exposes no call-creation function (existing N4 coverage, re-asserted here)', async () => {
    const vapi = await import('../src/lib/vapi.js');
    const names = Object.keys(vapi).join(' ').toLowerCase();
    expect(names).not.toMatch(/create|outbound|dial|place/);
  });

  it('the Twilio client exposes no call-creation or participant function', async () => {
    const twilio = await import('../src/lib/twilio.js');
    const names = Object.keys(twilio).join(' ').toLowerCase();
    expect(names).not.toMatch(/createcall|outbound|dial|participant|conference/);
  });
});
