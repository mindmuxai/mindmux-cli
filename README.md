# MindMux CLI

`mmx` gives your coding agent a project Brain: persistent knowledge it can read while working and update as decisions settle. Connect Claude Code or Codex to a Cloud or local Brain with one setup command.

## Install

Requires **Node.js 22+** and **macOS or Linux**. Install from source with pnpm:

```bash
git clone https://github.com/mindmuxai/mindmux-cli.git
cd mindmux-cli
pnpm install
pnpm add -g "$PWD"
```

Prefer npm? See [installation options](docs/installation.md).

## Get started

Inside the project you want to connect, run:

```bash
cd /path/to/your/project
mmx setup
```

Use the arrow keys and Enter to choose your agent, Workspace and Project, or create a new Project. Setup handles browser login, project MCP configuration, instructions and hooks, then checks the connection.

**Restart your agent and approve its trust prompts.** In Codex, also review the installed hooks with `/hooks`. You can then work as usual: the agent receives relevant Brain context and is guided to save confirmed decisions. You do not need to mention Brain in every request.

Want a local Brain without Cloud login? Run `mmx setup --local` instead.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `mmx` | Open the interactive menu |
| `mmx status --online` | Check the connection |
| `mmx doctor --fix` | Diagnose and repair setup |
| `mmx switch` | Choose another Brain |
| `mmx --help` | Show command help |

To start setup again, `mmx clean` resets local integration, binding, local Brain data and CLI login after confirmation. **Cloud data is kept.** Use `mmx clean --keep-login` to stay signed in. See [cleanup details](docs/setup.md#reset-for-testing).

## Documentation

- [Installation](docs/installation.md) — npm, pnpm and requirements.
- [Setup and maintenance](docs/setup.md) — agent trust, upgrades, repair and cleanup.
- [Brain commands](docs/brain.md) — query, write and index operations.
- [Cloud login](docs/cloud.md) — authentication and binding.
- [Agent behavior](docs/agents.md) — hooks, memory reviews and limits.
- [Development](docs/development.md) — tests and verification.

## License

Apache-2.0. See [LICENSE](LICENSE).
