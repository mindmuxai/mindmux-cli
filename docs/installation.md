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
mmx update          # Check, confirm with an arrow-key menu, and upgrade.
mmx update --check  # Check the latest stable release without installing.
mmx update --yes    # Upgrade without a confirmation prompt.
mmx update --check --json
```

Interactive menu, `setup`, `status` and `doctor` commands show a notice when a newer stable release is available. Passive checks are cached for 24 hours (including failures), have a short timeout, and never fail the command. Hook, MCP, Brain, JSON, non-interactive and CI calls do not check or print notices. Set `MINDMUX_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to disable passive checks. Explicit `mmx update --check` always checks again.

`update` compares the running package with npm/pnpm global roots, then uses its owning manager to install the exact checked version from the official npm registry. It does not switch managers, downgrade, use `sudo`, modify a source checkout, or update a project dependency. If both managers own the same path, select `--manager npm` or `--manager pnpm`; an unrelated manager is never accepted. An unavailable/unrecognized installer produces manual-update guidance instead of installing a second copy.

After installation, it verifies the new CLI version and runs the new CLI to refresh this project's existing managed MCP launchers, instructions and hooks. This refresh backs up configuration, preserves foreign entries, login, Brain binding and data, and does not contact Cloud or request browser authorization. A refresh failure is reported separately from a successful package installation; use `mmx doctor --fix` or `mmx setup` to resolve it. Restart the agent/MCP service afterwards. Other connected projects may need the same repair if their absolute paths or instructions are stale; they are not silently rewritten.

For older CLI versions without `update`, or for a manual upgrade:

```bash
npm install -g @mindmux/cli@latest
# Or:
pnpm add -g @mindmux/cli@latest
```

Then rerun `mmx setup` in each connected project and restart the agent. The new update mechanism becomes available after the first manual upgrade to a release containing it. `mmx update --refresh-integrations` can also refresh only the current project's owned configuration offline, without checking or installing a release.

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

## Verify the updater from source

`npm test` covers release checks, notification isolation, installer detection, failure cases and offline project refresh. For an opt-in end-to-end smoke test with real package managers:

```bash
node scripts/verify-update.mjs npm pnpm
```

This creates synthetic old/new package tarballs and isolated temporary global roots, then verifies version changes and refreshed launcher paths, including pnpm's versioned directories. It uses the network for public dependencies and prints the temporary report location. It does not update your actual CLI installation or touch existing projects. Pass only `npm` or `pnpm` to test one manager.
