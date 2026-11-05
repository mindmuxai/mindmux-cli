import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { binding, readJson, writeJson } from './storage.mjs';
import { withBrain } from './brain.mjs';
import { recall } from './recall.mjs';
import { beginReview, currentReview, stopReview, targetKey } from './review.mjs';
import { CLI_BIN, shellQuote } from './integrations.mjs';
import { homeDir } from './storage.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
export { targetKey } from './review.mjs';
const statePath = (root, agent, input) => join(root, '.mindmux/cli/sessions', `${agent}-${digest(String(input.session_id || input.conversation_id || 'default'))}.json`);
export function recordHook(root, agent, event, values) {
  writeJson(join(root, `.mindmux/cli/last-${agent}-${event}.json`), { time: new Date().toISOString(), targetKey: targetKey(root), agent, event, ...values });
}
const MEMORY_CHECK = 'MindMux memory check (once this turn): if this task settled a durable requirement, constraint or decision that has not already been captured, search/read the bound Brain and record it with its source. Do not store guesses or routine progress. If nothing qualifies, finish without writing. Do not repeat this check. Keep your final response focused on the user’s original request, in the user’s working language and requested format. Do not replace the answer with a memory-check report; if you already answered, preserve the substantive answer in the final response.';
const unboundContext = 'MindMux: this project has no selected Brain. Ask the user to choose an existing Cloud Brain, create a Project in an explicitly selected Workspace, or use mmx init --local. Do not infer a Brain from the folder name.';

function reviewInstructions(root, state) {
  const prefix = `env ${shellQuote('MINDMUX_HOME=' + homeDir())} ${shellQuote(process.execPath)} ${shellQuote(CLI_BIN)} --project ${shellQuote(root)}`;
  return `${state.receipt ? 'MindMux: this turn already has a registered review; repeat it only if new knowledge or another Brain write requires it.\n' : ''}MindMux memory review: BEFORE your final answer, check this entire task for uncaptured confirmed durable knowledge. Do not store greetings, guesses, tentative proposals or routine progress. Write and verify qualifying knowledge through the bound Brain.\nFor ALL Brain mutations this turn, pass --review-token ${state.token} to the CLI, or reviewToken to the mindmux_brain MCP tool. This lets the CLI verify successful writes. Raw Cloud tools cannot provide this verification.\nThen register the outcome: ${prefix} brain review --review-token ${state.token} --outcome <saved|no-changes|already-covered|deferred> --reason "short factual reason in the user's language" [--id existing-page]. saved requires actual verified writes in this turn; already-covered requires a relevant existing Page id; no-changes needs no Brain write. If persistence fails, report deferred with the reason instead of claiming success.\nMCP equivalent: mindmux_brain operation=review, reviewToken=${state.token}, outcome, reason, and id for already-covered. This is local workflow metadata, not a Brain Page. Complete it before answering and give one substantive response to the original task; do not add a separate memory-check report.`;
}

async function codexHook(root, event, input) {
  if (event === 'stop' || event === 'interrupt') {
    const result = await stopReview(root, event === 'interrupt' ? { ...input, hook_event_name: 'Interrupt' } : input);
    const { state, ...receipt } = result;
    recordHook(root, 'codex', event, receipt);
    if (state) return { decision: 'block', reason: `${reviewInstructions(root, state)}\nThis is the single recovery attempt. After completing it, preserve a substantive final answer to the original user task in their language. Never return an empty final answer or replace it with a memory-check status. The host may show this recovery and repeat the answer.` };
    return {};
  }
  if (event === 'pre-tool') return {};
  const previous = await currentReview(root, input);
  // Some hosts resubmit the Stop reason as a prompt in the same turn.
  if (event === 'prompt' && previous?.status === 'recovering' && (input.stop_hook_active || String(input.prompt).startsWith('MindMux memory review:'))) return {};
  const state = event === 'prompt' ? await beginReview(root, input) : previous;
  let result;
  try {
    result = binding(root).kind === 'unbound' ? { context: unboundContext, pageIds: [] }
      : await withBrain(root, brain => recall(brain, event === 'prompt' ? String(input.prompt || '').slice(0, 12000) : ''));
  } catch (error) {
    recordHook(root, 'codex', event, { status: 'error', error: error.message.slice(0, 500) });
    // Preserve review instructions even if recall failed; never reuse cached knowledge.
    return { hookSpecificOutput: { hookEventName: event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart',
      additionalContext: `MindMux recall failed. Do not infer missing knowledge or switch Brains. ${state ? reviewInstructions(root, state) : 'Use mmx doctor to inspect the connection.'}` } };
  }
  writeJson(statePath(root, 'codex', input), { targetKey: targetKey(root), ...result, recalledAt: Date.now() });
  recordHook(root, 'codex', event, { status: 'emitted', pageIds: result.pageIds, indexCount: result.count, indexSource: result.indexSource,
    bytes: Buffer.byteLength(result.context), review: state ? state.receipt ? 'registered' : 'pending' : 'unavailable', note: 'Returned to host; model usage is not observable.' });
  return { hookSpecificOutput: { hookEventName: event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart',
    additionalContext: result.context + (state ? '\n\n' + reviewInstructions(root, state) : '') } };
}

export async function handleHook(root, agent, event, input) {
  if (!['cursor', 'claude-code', 'codex'].includes(agent)) throw new Error('Hooks support cursor, claude-code and codex.');
  if (!['session-start', 'prompt', 'pre-tool', 'stop', 'interrupt'].includes(event)) throw new Error('Unknown hook event.');
  if (agent === 'codex') return codexHook(root, event, input);
  const path = statePath(root, agent, input);
  let state = readJson(path, {});
  const key = targetKey(root);
  if (state.targetKey !== key) state = { targetKey: key };
  const outputContext = (context, hookEventName) => agent === 'cursor' ? { additional_context: context }
    : { hookSpecificOutput: { hookEventName, additionalContext: context } };
  if (event === 'stop') {
    if (state.stopped || input.stop_hook_active || Number(input.loop_count || 0) > 0 || ['aborted', 'error'].includes(input.status)) return {};
    state.stopped = true;
    writeJson(path, state);
    recordHook(root, agent, event, { status: 'review-requested' });
    return agent === 'cursor' ? { followup_message: MEMORY_CHECK } : { decision: 'block', reason: MEMORY_CHECK };
  }
  if (event === 'pre-tool') {
    if (agent !== 'cursor' || !state.context || state.delivered) return {};
    if (Date.now() - state.recalledAt > 10 * 60 * 1000) return {};
    state.delivered = true;
    writeJson(path, state);
    recordHook(root, agent, event, { status: 'emitted', pageIds: state.pageIds || [], bytes: Buffer.byteLength(state.context),
      note: 'Returned to host; model usage is not observable.' });
    return outputContext(state.context);
  }
  const stopped = false;
  // Invalidate previous-turn context before any retrieval that may fail.
  writeJson(path, { targetKey: key, stopped });
  const result = binding(root).kind === 'unbound' ? { context: unboundContext, pageIds: [] }
    : await withBrain(root, brain => recall(brain, event === 'prompt' ? String(input.prompt || '').slice(0, 12000) : ''));
  state = { targetKey: key, context: result.context, pageIds: result.pageIds, indexCount: result.count, indexSource: result.indexSource, recalledAt: Date.now(), stopped,
    delivered: agent !== 'cursor' || event === 'session-start' };
  writeJson(path, state);
  recordHook(root, agent, event, { status: state.delivered ? 'emitted' : 'retrieved', pageIds: result.pageIds,
    indexCount: result.count, indexSource: result.indexSource, bytes: Buffer.byteLength(result.context), note: state.delivered ? 'Returned to host; model usage is not observable.' : 'Awaiting Cursor preToolUse; tool-free turns receive startup context only.' });
  if (agent === 'cursor' && event === 'prompt') return { continue: true };
  return outputContext(result.context, event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit');
}

export async function runHook(root, agent, event, input) {
  // No failing hook should block a task. Bound the entire process as well as individual requests.
  const timer = setTimeout(() => {
    try { recordHook(root, agent, event, { status: 'timeout', error: 'Hook exceeded 8 seconds.' }); } catch {}
    console.log(JSON.stringify(agent === 'cursor' && event === 'prompt' ? { continue: true } : {}));
    process.exit(0);
  }, 8000);
  try { return await handleHook(root, agent, event, input); }
  catch (error) {
    try { recordHook(root, agent, event, { status: 'error', error: error.message.slice(0, 500) }); } catch {}
    return agent === 'cursor' && event === 'prompt' ? { continue: true } : {};
  } finally { clearTimeout(timer); }
}
