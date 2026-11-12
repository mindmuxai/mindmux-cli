# Project setup and maintenance

[Back to README](../README.md) · [Documentation](README.md)

Run `mmx setup` inside the project you want to connect.

Use the Up/Down arrow keys and Enter to select agents, Workspaces, Projects, and confirmations. Select **+ Create a new Project** to create a Project; only its name requires typing. Empty, overlong, and duplicate names are validated in place so you can correct them without restarting. Cancelling creation returns to the Project menu; Ctrl+C exits setup.

The wizard also handles browser login. It installs project-level MCP configuration and agent instructions/hooks, then performs a real stdio MCP handshake and a read-only recall check.

Setup prints progress for login, discovery, validation, installation, and the MCP check. Progress goes to stderr and is suppressed with `--json`. Setup finishes with a short confirmation and instructions to restart your agent. For scripts or troubleshooting, use `mmx setup --json` to return the full structured result, including diagnostics and the backup path.

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

Claude Code uses the `mindmux` entry in `.mcp.json`, plus `CLAUDE.md` and hooks. Codex uses `mindmux_cli` in `.codex/config.toml`, plus `AGENTS.md` instructions and native hooks in `.codex/hooks.json`. These MCP identifiers remain unchanged by the executable rename. Generated MCP configuration contains executable paths and `MINDMUX_HOME`, rather than copied OAuth tokens. Restart the agent after setup and approve the applicable trust prompts.

## Codex hook setup and upgrades

The [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) describes the host protocol and trust controls. Codex hooks require a compatible Codex installation with the `hooks` feature enabled. Setup checks `codex features list` and warns if support cannot be verified or hooks are disabled; it does not change global Codex settings. Doctor reports unsupported or disabled hooks as errors and unavailable capability checks as warnings. If needed, update Codex or run `codex features enable hooks`.

For an existing instructions-only installation, rerun `mmx setup --agent codex` (add `--local` for a local Brain), or use `mmx doctor --fix`. Setup installs SessionStart, UserPromptSubmit, Stop, and Interrupt handlers in `.codex/hooks.json`, preserves unrelated hooks, and keeps `AGENTS.md` as workflow guidance. It does not change the brain.md storage implementation. Status and doctor detect older instructions-only installs as missing hooks. Setup adds `.codex/hooks.json` to the project's `.gitignore`; run setup in each worktree that needs these hooks.

Restart Codex, trust the project, and open `/hooks` to review new or changed definitions. Codex skips untrusted hooks; the CLI does not approve hooks or alter Codex's trust records. Hooks may also exist in global or inline TOML configuration, so inspect `/hooks` for duplicates. `mmx remove --agent codex` removes the hooks installed by setup while preserving unrelated hook definitions; `mmx clean` also removes the managed hooks as part of its local reset.

MindMux sets `statusMessage` on each Codex command handler, as supported by the [official hook configuration](https://learn.chatgpt.com/docs/hooks). In [Codex 0.162.0](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/bottom_pane/hooks_browser_view.rs), this field also supplies the title in `/hooks`; missing or blank values appear as “Unnamed hook.” MindMux's labels are:

| Event | Label |
| --- | --- |
| SessionStart | MindMux: load Brain context |
| UserPromptSubmit | MindMux: recall project knowledge |
| Stop | MindMux: verify memory review |
| Interrupt | MindMux: close interrupted review |

If an older installation shows unnamed MindMux hooks, update the CLI and run `mmx connect --agent codex` in that project, then restart Codex and review `/hooks`. Repeating setup also refreshes these labels while preserving unrelated hooks. `mmx doctor --fix` restores named handlers when it repairs missing hooks; missing labels alone do not trigger repair. A reset is not required. Labels identify the handlers; they do not approve hook trust or prove that a hook ran.

SessionStart injects base Brain context (including after resume/compaction); UserPromptSubmit retrieves relevant project knowledge. UserPromptSubmit supplies a token for the agent to register its memory review before answering. Stop silently accepts a registered review; otherwise it requests at most one recovery, and continuation prompts do not reset this guard. Interrupt invalidates the active review token. See [Agent behavior](agents.md) for the review protocol and failure limits. Writes still require the agent to identify confirmed durable knowledge and call the CLI/MCP. Hook failures are recorded and allow the task to proceed; no automatic Cloud-to-local fallback occurs. Use `mmx status` to inspect observed hook delivery, or `mmx doctor` to check installation and Codex hook capability; neither can verify that Codex trusted a definition or used the returned context.

## Interactive menu

Run `mmx` without arguments in a terminal to open the arrow-key menu. An unconfigured project offers setup first. Configured projects offer status, live connection checks, diagnosis and repair, Brain switching, and agent configuration. More options include removing selected agent connections and resetting local setup. Removal requires confirmation; local reset retains its own scope preview and confirmation. Actions return to the menu, and Ctrl+C or Exit closes it.

`mmx --help` always prints command help. Running without arguments in a non-interactive environment, or with `--json` or `--yes`, prints help without waiting for input. Explicit subcommands remain available for scripts.

## Diagnose and repair

```bash
mmx doctor                       # Readable local diagnostics; no network calls.
mmx doctor --online              # Also check Brain access and MCP recall.
mmx doctor --fix                 # Review the repair plan and confirm with arrow keys.
mmx doctor --json                # Structured report, including the repair plan.
mmx doctor --fix --yes --json     # Explicit non-interactive repair approval.
```

Doctor explains each problem and the suggested next action. Repair restores missing setup-managed entries and instructions/hooks, refreshes stale executable paths, and preserves unrelated configuration, the Brain binding, login, and Brain data. It backs up project configuration and runs an MCP recall check; a failed check rolls back configuration. Cloud repair can require browser login. Restart the configured agents after successful repair.

Modified MCP entries, malformed configuration, unsafe paths, and conflicting integrations are not overwritten. If project files change after the repair plan is shown, repair stops so you can review a new plan. Connect-only integrations are diagnosed, but automatic repair requires a setup-managed installation. Use `mmx setup` for initial configuration. Diagnostics return a nonzero exit status while errors remain; warnings alone do not fail the command. Doctor output now defaults to text, so scripts should explicitly pass `--json`.

## Check status and switch Brains

```bash
mmx status                  # Local configuration and observed activity; no network calls.
mmx status --online         # Also check Brain access and the configured MCP launcher.
mmx status --json           # Structured details for scripts.
mmx switch                  # Choose a Workspace and Project with arrow keys.
mmx switch --brain-id <brain-id> --yes
mmx switch --local --yes
```

`status` distinguishes saved credentials, agent configuration, live read-only checks, successful MCP client tool calls, and hook context delivery. Successful setup is described as **Configured for**, because it does not establish that the agent has connected. Codex uses native lifecycle hooks alongside project instructions. Project-local hooks require a trusted project and review of each hook definition through `/hooks`. Neither a tool call nor delivered context proves that the model used the knowledge in its answer.

Usage receipts are bounded to the most recent successful MCP tool call and each hook event. They record timestamps, client/tool/operation names and a binding fingerprint, without tool arguments or results. Setup and status probes do not count as agent activity. Status ignores receipts from a different binding or before the latest successful setup; it cannot observe calls made directly to a separate remote MCP connection or CLI.

`switch` requires an existing `setup` installation and reuses all setup-managed agents. It keeps login credentials and Brain data. The selected Brain must pass validation and the MCP recall check; failures restore the previous binding and project configuration. Ctrl+C at a selection prompt cancels without changing the binding. Restart the agent after switching so its MCP server uses the new Brain.

If Cloud Project creation succeeds but a later setup step fails, the error provides a command with that Brain ID to resume installation. The Cloud Project is retained. A local creation journal prevents a known creation from being replayed. If a creation request loses its response, inspect `mmx project list` before trying again; writes are never automatically retried.

## Existing integrations and migration

Codex merges global and project entries with the same name. The local transport therefore uses a separate name. Recognized global MindMux remote entries are disabled only in the current project through an `enabled = false` override; global configuration remains intact. Setup stops if a global `mindmux_cli` entry would conflict with the project transport.

Use `mmx setup --migrate` to replace an existing project-level remote MCP entry. The original value is backed up and restored by `remove`. Initial TOML migration may reorder content or move comments; the complete original file is retained in the backup. Subsequent ordinary installs preserve unmanaged content. User-modified managed MCP entries are protected from replacement and removal.

Migration also invokes the official brain.md project hook uninstaller for recognized legacy SessionStart hooks. Global brain.md skills and other global settings are reported but are not removed. Inspect custom aliases and higher-priority Claude local-scope entries in the agent itself.

Configuration backups are stored under `~/.mindmux-cli/backups/` or `MINDMUX_HOME/backups/`, outside the project, with mode `0600`. Failed installation or self-check restores project configuration. Brain data and successfully created remote Projects survive rollback. A creation journal prevents blindly repeating a remote creation whose outcome is unknown; inspect `mmx project list` before retrying when instructed.

`remove` removes setup-managed project integrations while retaining Brain data, binding, login, and unrelated configuration. For integrations installed only with `connect`, use `disconnect`.

## Reset for testing

Run `mmx clean` in the project to reset its local MindMux state. The arrow-key confirmation lists the cleanup scope before anything is removed.

```bash
mmx clean
mmx setup

# Reset the project while keeping CLI login.
mmx clean --keep-login

# Explicit confirmation for non-interactive scripts.
mmx clean --yes --json
```

Cleanup removes managed MCP entries, instructions and hooks, project binding, session caches, local Brain data, the shared update-check cache, and this project's configuration backups. By default, it also removes **all CLI login credentials and the saved server setting** from the current `MINDMUX_HOME`, which signs out other projects sharing that CLI login. `--keep-login` retains both. This removes local credentials; it does not revoke server grants or end a browser session.

**Cloud Projects and Brains are always kept.** Existing cloud Projects can be selected in the next setup. Unrelated agent configuration, custom instructions, unknown preference fields, and other projects' backups are preserved. Empty generated files are removed, and an unchanged brain.md scaffold is removed with local Brain data. Git ignore rules are retained.

Cleanup removes only CLI-owned commands from mixed hook groups, preserving user handlers and group settings. Hook ownership can be recovered from the saved setup launcher if the integration receipt is missing. If the MCP setup ownership record is missing, cleanup stops before deleting data instead of guessing the original configuration.

Cleanup refuses modified managed MCP entries, unsafe paths, symbolic links, pending browser authorization, and active setup/write/authentication/update locks. Stop active agents before resetting. A configured local Brain outside the project requires `--include-external-data`; its path is shown in the confirmation. Local data deletion cannot be undone by `remove`.
