import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { createSetupPrompts } from '../src/prompts.mjs';

function terminal(t) {
  const input = new PassThrough();
  const output = new PassThrough();
  // Like process.stderr, this destination stays open between prompts.
  output.end = () => output;
  let screen = '';
  output.on('data', chunk => { screen += chunk.toString(); });
  t.after(() => { input.destroy(); output.destroy(); });
  const waitFor = async text => {
    for (let i = 0; i < 200; i++) {
      if (screen.includes(text)) return;
      await setTimeout(5);
    }
    assert.fail(`Prompt did not display: ${text}`);
  };
  return { prompts: createSetupPrompts({ input, output }), input, waitFor };
}

test('agent choices accept arrow keys and Enter without typed agent identifiers', async t => {
  const { prompts, input, waitFor } = terminal(t);
  const result = prompts.agents(['claude-code']);
  await waitFor('Which agents');
  input.write('\x1b[B'); // Down: Claude Code -> Codex.
  input.write('\r');
  assert.equal(await result, 'codex');
});

test('Workspace choices preserve identity and support Down, Up, and Enter', async t => {
  const { prompts, input, waitFor } = terminal(t);
  const first = { id: 'first' }, second = { id: 'second' };
  const result = prompts.choose('Select a Workspace:', [
    { name: 'First Workspace', value: first }, { name: 'Second Workspace', value: second },
  ]);
  await waitFor('First Workspace');
  input.write('\x1b[B'); input.write('\x1b[A'); input.write('\r');
  assert.equal(await result, first);
});

test('creation confirmation defaults to cancel and requires selecting Confirm', async t => {
  const { prompts, input, waitFor } = terminal(t);
  const cancelled = prompts.confirm('Cancel by default?');
  await waitFor('Cancel by default?'); input.write('\r');
  assert.equal(await cancelled, false);
  const confirmed = prompts.confirm('Explicit creation?');
  await waitFor('Explicit creation?'); input.write('\x1b[B'); input.write('\r');
  assert.equal(await confirmed, true);
});

test('empty, duplicate, and overlong names can be corrected without exiting the prompt', async t => {
  const { prompts, input, waitFor } = terminal(t);
  const result = prompts.projectName([{ name: 'Existing Project' }]);
  await waitFor('New Project name:'); input.write('\r');
  await waitFor('Enter a Project name.');
  input.write(' existing PROJECT '); input.write('\r');
  await waitFor('A Project with this name already exists.');
  input.write('x'.repeat(201)); input.write('\r');
  await waitFor('Use at most 200 characters.');
  input.write('  mindmux-cli  '); input.write('\r');
  assert.equal(await result, 'mindmux-cli');
});

test('Ctrl+C cancels the prompt rather than accepting a selection', async t => {
  const { prompts, input, waitFor } = terminal(t);
  const result = prompts.agents([]);
  const cancelled = assert.rejects(result, error => error.name === 'ExitPromptError');
  await waitFor('Which agents'); input.write('\x03');
  await cancelled;
});
