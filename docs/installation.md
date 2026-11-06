# Installation

[Back to README](../README.md) · [Documentation](README.md)

## Requirements

- Node.js 22 or later.
- macOS or Linux. Generated hook commands use POSIX shell quoting; native Windows shells are not supported yet.
- A supported agent installed locally. Unified setup supports Claude Code and Codex. Cursor integration is available separately through `connect`.

## Install from source

Use Node.js 22 or later. With pnpm:

```bash
git clone https://github.com/mindmuxai/mindmux-cli.git
cd mindmux-cli
pnpm install
pnpm add -g "$PWD"

cd /path/to/your/project
mmx setup
```

If pnpm reports that its global bin directory is missing, run `pnpm setup`, reopen your terminal, and retry `pnpm add -g "$PWD"`. Source installation does not require a published `@mindmux/cli` package. Keep the source directory available for the installed command.

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
