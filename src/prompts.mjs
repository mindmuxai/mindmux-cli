import { input, select } from '@inquirer/prompts';

// Keep terminal UI on stderr so stdout remains machine-readable JSON.
export function createSetupPrompts(context = { input: process.stdin, output: process.stderr }) {
  const choose = (message, choices, initial) => select({ message, choices, default: initial, pageSize: 10 }, context);
  return {
    agents: installed => choose('Which agents should be connected?', [
      { name: 'Claude Code', value: 'claude-code' },
      { name: 'Codex', value: 'codex' },
      { name: 'Claude Code and Codex', value: 'claude-code,codex' },
    ], installed.join(',') || 'claude-code,codex'),
    choose,
    confirm: message => choose(message, [
      { name: 'Cancel', value: false },
      { name: 'Confirm', value: true },
    ], false),
    projectName: projects => input({
      message: 'New Project name:',
      theme: { validationFailureMode: 'clear' },
      validate: value => {
        const name = value.trim();
        if (!name) return 'Enter a Project name.';
        if (name.length > 200) return 'Use at most 200 characters.';
        if (projects.some(project => project.name.trim().toLowerCase() === name.toLowerCase())) {
          return 'A Project with this name already exists. Choose another name or select the existing Project.';
        }
        return true;
      },
    }, context).then(value => value.trim()),
  };
}
