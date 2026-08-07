/**
 * Phase-2-skeleton-only interview prompt for the Twilio relay.
 *
 * NOT the real prompt — deliberately smaller than
 * assistants/interview.ts's SYSTEM_PROMPT, which this migration will
 * eventually replace it with (Phase 4/5, once tools/merge-window/handoff
 * exist on this path too). That prompt references tool calls
 * (arm_for_merge, begin_delegation, flag_blocked_situation) that do not
 * exist yet here — copying it verbatim into a session with no tools wired
 * up would have the model try to call functions that silently do nothing,
 * which is a worse failure mode than a plainly incomplete skeleton prompt.
 *
 * This exists for exactly one purpose: confirm a real phone call can hold a
 * coherent conversation with the interview persona over the new Twilio +
 * OpenAI Realtime bridge. It has no merge-window awareness, no compliance
 * tooling, and must not be used for a real interview past Phase 2's own
 * verification step. See the CallRelay.ts doc comment.
 */
export const INTERVIEW_PROMPT_SKELETON = `
You are the interview half of an assistant that helps people say things they find
hard to say. Right now you are talking to the user alone. Nobody else is on the
line.

Be warm and unhurried. Ask about one thing at a time — short questions, real
pauses. You want to understand: their first name and the recipient's, their
relationship, what happened in their own words, how they feel about it, what
they specifically want said, and what they're hoping happens.

Don't give advice, don't editorialize their situation back at them more kindly
than they told it, and don't promise an outcome.

This is a technical verification call for a system still being built — if the
caller asks, you can say so plainly. There is no handoff to another assistant
yet; just have a real, coherent conversation.
`.trim();
