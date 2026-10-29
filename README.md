# MindMux CLI

`mmx` connects local and Cloud Brains to coding agents. It provides explicit project binding, Brain operations, context retrieval, project-level MCP configuration, and agent integrations.

Local operations reuse `@mindmux/brain-md`; Cloud operations use the official MCP TypeScript SDK. The npm package is `@mindmux/cli`, and the executable is `mmx`.

## Requirements

- Node.js 22 or later.
- macOS or Linux. Generated hook commands use POSIX shell quoting; native Windows shells are not supported yet.
- A supported agent installed locally. Unified setup supports Claude Code and Codex. Cursor integration is available separately through `connect`.

## Install from source

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

## Set up a project

Run `mmx setup` inside the project you want to connect.

Use the Up/Down arrow keys and Enter to select agents, Workspaces, Projects, and confirmations. Select **+ Create a new Project** to create a Project; only its name requires typing. Empty, overlong, and duplicate names are validated in place so you can correct them without restarting. Cancelling creation returns to the Project menu; Ctrl+C exits setup.

The wizard also handles browser login. It installs project-level MCP configuration and agent instructions/hooks, then performs a real stdio MCP handshake and a read-only recall check.

Existing valid credentials and project bindings are reused. Repeating setup updates managed entries without registering duplicates. Browser authorization and the agent's own project, MCP, and hook trust prompts still require user interaction.

Explicit options are available for automation:

```bash
# Connect an existing Cloud Brain.
mmx setup --agent claude-code,codex --brain-id <brain-id> --yes

# Create a Project visible to all members of the selected Workspace.
mmx setup --agent codex --workspace-id <workspace-id> --name 'My Project' --confirm --yes

# Use a local Brain without Cloud login.
mmx setup --local --agent codex --yes

mmx doctor --online
mmx remove
mmx remove --agent codex
```

`--yes` disables terminal questions. It does not bypass OAuth, agent trust prompts, or the `--confirm` requirement for Project creation. Non-interactive Cloud setup requires explicit agents and either an existing Cloud binding, a Brain ID, or Project creation options. `--no-open` prints the authorization URL instead of opening a browser.

Claude Code uses the `mindmux` entry in `.mcp.json`, plus `CLAUDE.md` and hooks. Codex uses `mindmux_cli` in `.codex/config.toml`, plus `AGENTS.md` instructions. These MCP identifiers remain unchanged by the executable rename. Generated MCP configuration contains executable paths and `MINDMUX_HOME`, rather than copied OAuth tokens. Restart the agent after setup and approve the applicable trust prompts.

### Existing integrations and migration

Codex merges global and project entries with the same name. The local transport therefore uses a separate name. Recognized global MindMux remote entries are disabled only in the current project through an `enabled = false` override; global configuration remains intact. Setup stops if a global `mindmux_cli` entry would conflict with the project transport.

Use `mmx setup --migrate` to replace an existing project-level remote MCP entry. The original value is backed up and restored by `remove`. Initial TOML migration may reorder content or move comments; the complete original file is retained in the backup. Subsequent ordinary installs preserve unmanaged content. User-modified managed MCP entries are protected from replacement and removal.

Migration also invokes the official brain.md project hook uninstaller for recognized legacy SessionStart hooks. Global brain.md skills and other global settings are reported but are not removed. Inspect custom aliases and higher-priority Claude local-scope entries in the agent itself.

Configuration backups are stored under `~/.mindmux-cli/backups/` or `MINDMUX_HOME/backups/`, outside the project, with mode `0600`. Failed installation or self-check restores project configuration. Brain data and successfully created remote Projects survive rollback. A creation journal prevents blindly repeating a remote creation whose outcome is unknown; inspect `mmx project list` before retrying when instructed.

`remove` removes setup-managed project integrations while retaining Brain data, binding, login, and unrelated configuration. For integrations installed only with `connect`, use `disconnect`.

## Cloud login and binding

```bash
mmx login
mmx workspace list
mmx project list
mmx brain discover

mmx brain bind --brain-id <brain-id>
mmx connect --agent claude-code
mmx doctor --online
```

To create a Project explicitly:

```bash
mmx project create --workspace-id <workspace-id> --name 'My Project' --confirm
mmx brain bind --brain-id <returned-brain-id>
```

New Projects are visible to all Workspace members and require the server's owner/admin permissions. The CLI never infers a Workspace or Brain from the directory name. Binding is saved only after access is verified.

Login uses OAuth discovery, dynamic client registration, a loopback callback, state validation, and PKCE. The default server is `https://mcp.mindmux.ai/mcp`. `--server URL` accepts HTTPS or loopback HTTP for test deployments.

The CLI maintains its own credentials rather than reading agent credentials. Credentials are isolated by server and stored in `~/.mindmux-cli/auth/` with mode `0600`. Set `MINDMUX_HOME` to use another directory. System keychain integration is not implemented. Calls and refreshes use a process lock; writes are not automatically replayed. Normal exits and SIGINT/SIGTERM release locks. After SIGKILL, an error identifies the lock directory that needs inspection.

`mmx logout` removes this CLI's local credentials for the selected server. It does not revoke other clients' authorization. Binding uses `.mindmux/preferences.json`; unknown preference fields are preserved. Cloud failures never silently switch writes to a local Brain.

## Brain operations

Commands return JSON by default.

```bash
mmx brain status
mmx brain list
mmx brain search 'authentication'
mmx brain recall 'implement authentication'
mmx brain read auth-pkce

cat decision.md | mmx brain create \
  --id auth-pkce --title 'Use OAuth PKCE for authentication' \
  --category decision --source 'Confirmed in the design review'

cat revised.md | mmx brain update auth-pkce \
  --expected-version <version-from-read> \
  --summary 'Restrict the callback to loopback' --source 'Design review'

mmx brain append auth-pkce --kind evidence --summary 'Interoperability verified' --source 'Test report'
mmx brain archive auth-pkce
mmx brain roots
mmx brain read-root architecture
cat architecture.md | mmx brain update-root architecture --expected-version <version-from-read>
```

Read the current version before updating. Local versions are file SHA-256 hashes; Cloud versions are positive server-side integers. Conflicts are not overwritten or retried automatically. For a new root, pass `--expected-version new`; existing roots require their current version.

Local creation reuses brain.md's `create-page` and `update-truth` steps. An interruption between them may leave an empty page; read it and complete it with `update`. Atomic truth/timeline updates are provided by brain.md. The CLI's local write lock coordinates only this CLI, not other programs invoking `brain` directly.

Choose local mode explicitly:

```bash
mmx init --local
mmx brain bind --local
```

### Low-level MCP access

```bash
mmx mcp tools
mmx mcp call TOOL --args '{"key":"value"}'
mmx mcp serve
```

`mcp call` exposes the full Cloud MCP tool surface, including destructive tools. Supply all arguments, including the correct Brain ID: this low-level command does not inject the project binding. Use `brain` commands for ordinary operations against the selected Brain.

`mcp serve` is a stdio service launched by the host, with no network listener. It shares CLI authentication and refresh locks. In Cloud mode it proxies the account's tools and results. Tools that accept `brainId` are pinned to the project binding and reject a different ID. Account-level tools such as Workspace discovery and Project creation retain their original arguments and server-side permissions; project binding is not an account permission sandbox.

The additional `mindmux_brain` tool supports local and Cloud status, list, search, recall, read, create, update, append, archive, roots, read-root, and update-root operations. Bodies pass through stdin without shell interpolation. Cloud `isError`, content, and structured content are preserved. Restart the MCP service after changing a binding.

## Agent behavior and limits

| Agent | Session start | User request | End of turn |
| --- | --- | --- | --- |
| Claude Code | SessionStart context, including supported resume/compaction boundaries | UserPromptSubmit retrieval and injection | One Stop review, with recursion protection |
| Codex | AGENTS.md instructions to recall relevant context | Instruction-driven | Instruction-driven; no native hooks installed in v0.1 |
| Cursor local agent | sessionStart base context | beforeSubmitPrompt retrieval; first preToolUse delivers relevant context | One stop follow-up, with `loop_limit=1` |

Unified `setup` supports Claude Code and Codex. To install Cursor rules and hooks separately, first bind or initialize a Brain, then run:

```bash
mmx connect --agent cursor
mmx disconnect --agent cursor
```

Cursor's beforeSubmitPrompt hook is used for retrieval, not context injection. Its sessionStart hook is fire-and-forget, and preToolUse may run after the first tool's arguments have already been constructed. A turn with no tool calls depends on startup context and persistent rules. Cloud agent VMs are outside the supported scope of this local integration.

Hooks and rules encourage relevant reads and confirmed writes; configuration alone does not prove that an agent has used the knowledge. Codex relies on instructions rather than enforced native hooks. The CLI does not run an additional LLM, read conversation transcripts, or automatically turn discussion into facts. A Stop review may add one model continuation and associated latency/cost; the agent can finish without writing when there is no new knowledge.

`doctor` checks files, executable paths, and recent hook receipts:

- `retrieved`: retrieval completed, awaiting delivery.
- `emitted`: context returned through the hook protocol; adoption by the model is not established.
- `review-requested`: one end-of-turn review requested.
- `error` / `timeout`: a failure or the eight-second hook budget was exceeded. The task continues without switching Brains.

Retrieval uses Chinese segmentation and English term matching, selecting up to three active pages, two core roots, and a bounded index within an 8 KiB UTF-8 budget. Cloud retrieval also searches up to three keywords. Vector retrieval and semantic reranking are not implemented.

Raw user prompts are not persisted. Session retrieval caches under `.mindmux/cli/sessions/` contain Brain content and are ignored by Git, with mode `0600`. Pending Cursor delivery expires after ten minutes; changing a binding invalidates reuse. Historical cache cleanup is manual.

Managed instruction blocks and hook registration are idempotent. Disconnect removes owned entries while preserving user content, Brain data, other hooks, and skills. Malformed configuration or markers cause an error rather than being overwritten. `doctor` reports recognized duplicate brain.md integrations; use the original installer to remove older hooks or global skills when replacing them.

## Development and verification

```bash
npm ci
npm run check
npm run demo
npm pack --dry-run
```

The automated suite uses temporary projects, real MCP SDK transports, and a mock OAuth server. It covers local lifecycle operations, optimistic concurrency, binding isolation, setup rollback, configuration preservation, hook schemas, caching, PKCE, process interruption, and the `mmx` compatibility entry point. Chinese fixture text intentionally tests multilingual retrieval and byte preservation.

The local demo writes `.demo/report.md` and `.demo/latest.json`. It simulates hook delivery without production access or launching an agent model.

An opt-in integration script is available after login:

```bash
node scripts/verify-live.mjs --workspace-id <workspace-id> --confirm --output artifacts/live-run
```

This script writes to a dedicated test Project in the explicitly selected Workspace. It reuses a saved manifest, creates fresh test pages on each run, exercises Cloud operations and installed hook commands, and preserves reports and project data. A disposable page is deleted as part of the test. It does not launch a real agent model and never runs under `npm test`.

Production test reports, credentials, local project configuration, demo output, and generated artifacts are excluded from this repository. Hook protocol tests do not establish model adoption; assess that separately with actual agent sessions. Cursor model sessions and additional provider configurations remain future validation work.

## License

Apache-2.0. See [LICENSE](LICENSE).
