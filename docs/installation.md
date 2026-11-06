# Installation

[Back to README](../README.md) · [Documentation](README.md)

## Requirements

- Node.js 22 or later.
- macOS or Linux. Generated hook commands use POSIX shell quoting; native Windows shells are not supported yet.
- A supported agent installed locally. Unified setup supports Claude Code and Codex. Cursor integration is available separately through `connect`.

## Install from npm

Install the published package globally to make `mmx` available in your terminal:

```bash
npm install -g @mindmux/cli
```

Or with pnpm:

```bash
pnpm add -g @mindmux/cli
```

If pnpm reports a missing global bin directory, run `pnpm setup`, reopen your terminal, and retry.

If a registry mirror returns 404 for a newly published version, retry against the official npm registry:

```bash
npm install -g @mindmux/cli --registry=https://registry.npmjs.org
# Or:
pnpm add -g @mindmux/cli --registry=https://registry.npmjs.org
```

Then run setup inside the project you want to connect:

```bash
cd /path/to/your/project
mmx setup
```

`npm install @mindmux/cli` without `-g` installs a project dependency; it does not add a global `mmx` command. For the standard CLI workflow, use the global installation above.

## Update

```bash
npm install -g @mindmux/cli@latest
# Or:
pnpm add -g @mindmux/cli@latest
```

Rerun `mmx setup` in each connected project to refresh managed paths and integrations, then restart the agent and review any new trust prompts.

## Install from source

Source installation is available for development or testing unpublished changes. It is not required to use the CLI.

Use Node.js 22 or later. With pnpm:

```bash
git clone https://github.com/mindmuxai/mindmux-cli.git
cd mindmux-cli
pnpm install
pnpm add -g "$PWD"

cd /path/to/your/project
mmx setup
```

If pnpm reports that its global bin directory is missing, run `pnpm setup`, reopen your terminal, and retry `pnpm add -g "$PWD"`. Keep the source directory available for the installed command.

With npm:

```bash
git clone https://github.com/mindmuxai/mindmux-cli.git
cd mindmux-cli
npm ci
npm install -g .

cd /path/to/your/project
mmx setup
```

`npm ci` installs dependencies but does not install the global command. Keep the CLI installation and Node executable available: generated integrations use absolute paths. After moving the CLI, moving a project, or changing Node, rerun `mmx setup` to refresh those paths. Set up each new worktree separately.

The old `bin/mindmux.mjs` script remains as a compatibility entry point for existing integrations. New installations use `bin/mmx.mjs`.
