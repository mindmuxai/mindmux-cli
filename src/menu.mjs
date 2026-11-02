import { basename, join } from 'node:path';
import { binding, readJson } from './storage.mjs';
import { createSetupPrompts } from './prompts.mjs';

export async function runMenu(root, { prompts = createSetupPrompts(), run, write = value => console.log(value) } = {}) {
  for (;;) {
    let target, agents = [];
    try { target = binding(root); agents = Object.keys(readJson(join(root, '.mindmux/cli/setup.json'), {}).agents || {}); }
    catch { target = { kind: 'invalid' }; }
    const setupArgs = target.kind === 'local' ? ['setup', '--local'] : ['setup'];
    const ready = ['local', 'cloud'].includes(target.kind) && agents.length > 0;
    write(`\nMindMux · ${basename(root)}\nBrain: ${target.kind === 'cloud' ? target.name || target.brainId : target.kind === 'local' ? 'Local' : target.kind === 'invalid' ? 'Configuration needs attention' : 'Not selected'}\nConfigured agents: ${agents.join(', ') || 'None'}\n`);
    try {
      const choice = await prompts.choose('What would you like to do?', [
        ...(!ready ? [{ name: 'Set up this project', value: setupArgs }] : []),
        { name: 'View status', value: ['status'] },
        { name: 'Check live connection', value: ['status', '--online'] },
        { name: 'Diagnose and repair', value: ['doctor', '--fix'] },
        ...(ready ? [
          { name: 'Switch Brain', value: ['switch'] },
          { name: 'Set up or refresh agent connections', value: setupArgs },
        ] : []),
        { name: 'More options', value: 'more' },
        { name: 'Exit', value: 'exit' },
      ]);
      if (choice === 'exit') return;
      if (choice === 'more') {
        const extra = await prompts.choose('More options:', [
          ...(agents.length ? [{ name: 'Remove agent connections (keep Brain data and login)', value: 'remove' }] : []),
          { name: 'Reset local setup and data (keep Cloud data)', value: ['clean'] },
          { name: 'Show command help', value: ['help'] },
          { name: 'Back', value: 'back' },
        ]);
        if (extra === 'back') continue;
        if (extra === 'remove') {
          const agent = await prompts.choose('Remove connections for:', [
            ...agents.map(value => ({ name: value, value })),
            ...(agents.length > 1 ? [{ name: 'All configured agents', value: agents.join(',') }] : []),
            { name: 'Cancel', value: false },
          ]);
          if (agent && await prompts.confirm(`Remove ${agent} connections? Brain data, binding and login will be kept.`)) await run(['remove', '--agent', agent]);
        } else await run(extra);
      } else await run(choice);
    } catch (error) {
      if (error.name === 'ExitPromptError') return;
      write(`Unable to complete the action: ${error.message}`);
    }
  }
}
