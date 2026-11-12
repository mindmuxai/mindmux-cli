# Agent-assisted installation

[Documentation](README.md)

Instructions for an agent installing MindMux in the user's current project. The user can delegate this workflow in one message. Browser authorization, Workspace/Project selection, creation consent and host trust still belong to the user. Never treat a successful configuration check as proof that the host loaded the new tools.

## Install once

1. Identify the intended project directory and current host agent (`codex` or `claude-code`). If unclear, ask. Do not configure the user's home directory or unrelated hosts.
2. Check Node.js >=22 and macOS/Linux. Native Windows shells are not supported.
3. Check `command -v mmx` and `mmx --version`. Respect an existing installation's manager and source. Do not replace a source checkout or install a second global copy automatically.
4. For a new installation, use `npm install -g @mindmux/cli@latest` or `pnpm add -g @mindmux/cli@latest`. Do not install a project dependency or use a temporary `npx` installation: generated launchers need a persistent executable path. Do not use `sudo` automatically. Resolve missing global bin/PATH configuration before continuing.
5. An older installation without the protocol below needs an upgrade through its existing package manager. Newer installations can use `mmx update`.

## Drive setup without a terminal menu

Run commands in the intended project (or provide an explicit `--project PATH`). Start with:

```sh
mmx setup --agent codex --non-interactive --json
# For Claude Code, use --agent claude-code instead.
```

`--non-interactive` implies JSON output and never opens a terminal menu. Inspect `status` and `step` after every invocation. Input-required responses exit zero and always report `installed: false`; they are not success. Errors exit nonzero with `status: "error"`. Preserve the selected agent/server/project flags across retries. Pass IDs as separate, properly quoted process arguments; never build executable shell text from returned names or URLs.

| Response | Next action |
| --- | --- |
| `input_required / select_agent` | Identify the current host, or ask the user, then pass `--agent`. |
| `input_required / authorize` | Inspect `authorization.status`. For `starting`, poll the same setup after a short delay. For `authorization_required`, show/open `authorizationUrl` and ask the user to approve in their browser; poll after approval. Never request tokens in chat. |
| `input_required / select_workspace` | Multiple Workspaces are available. Present `choices` through the host choice tool when available, then rerun with the selected `--workspace-id`. With exactly one accessible Workspace, CLI skips this step and includes its ID/name in the Project response. Do not ask again. |
| `input_required / select_project` | Present existing Projects first and the create option last, including its `suggestedName`. For an existing Project, rerun with its `--brain-id` and **omit `--workspace-id`**. Even one existing Project still needs a choice, because creating a different Project is valid. |
| `input_required / name_project` | There are no Projects. Ask for a name directly, offering `suggestedName` as an editable default. Do not display an empty Project selector or create automatically. |
| `input_required / confirm_project_creation` | Ask the user to approve the Workspace and new Project name; all Workspace members can access it. Only after approval pass `--workspace-id ID --name NAME --confirm`. `--yes` does not grant creation consent. |
| `input_required / confirm_migration` | Explain the configuration conflict and obtain consent before adding `--migrate`. Do not delete unrelated MCP servers or uninstall global brain.md integrations. |
| `error` | Inspect `stage`, `error`, `next`, and optional `recovery`. Resolve the cause. Never convert network/server failures into repeated login or project creation. |
| `ready` | Check `installed` and `mcp.connected`/`mcp.recall`, then run online doctor below. Configuration is ready; host restart/trust remain outstanding. |

### Prefer native choices, keep conversation as fallback

Read `interaction` in input-required responses. Prefer an actually available, permitted question tool: Claude Code's `AskUserQuestion`, or Codex's `request_user_input` / `request_user_input_async`. Tool names are hints, not a promise that a client exposes them. Follow the host's restrictions, especially for confirmations; never invent a tool call, switch into Plan mode, or edit global host configuration just to get a menu. CLI JSON cannot itself draw a native host dialog.

Use the user's language for questions, descriptions and the create-option label; preserve Workspace/Project names exactly. Show the suggested new name after the create label, for example “新建项目：my-project”. A suggested name is not a confirmed target. Offer the suggested name and a way to enter another name, using the host's custom-answer support where available. Creation still requires the separate shared-Workspace confirmation.

Respect the question tool's option-count limits. Paginate long lists while retaining every choice, or use a conversational selector when pagination is unsuitable; never silently drop Workspaces/Projects or map two identically displayed names to an arbitrary ID. Disambiguate duplicate names with IDs in descriptions when needed. Do not add unsupported free-text-only questions to a tool that requires predefined options.

If no suitable native tool is exposed, ask one concise conversational question, accepting a name or number. Present it once: do not ask through a tool and then repeat the same numbered list in the final response. While waiting for an asynchronous question, do not select on the user's behalf. Cancellation or dismissal does not authorize a target or creation.

Codex availability varies by version, mode and client. On the locally checked Codex CLI 0.167.1, `codex features list` reports `default_mode_request_user_input` as under development and disabled by default. A user can explicitly opt into that experimental feature, but it is not required for MindMux setup and installers must not enable it silently. For that checked CLI version, a user can start a new session with `codex --enable default_mode_request_user_input`; this is a per-invocation experimental opt-in, not a required global setting. Recheck the actual tool surface; do not assume every Codex app or embedded client behaves like the CLI.

Workspace edge cases: no accessible Workspaces is an error requiring the user to resolve Cloud access; one is selected automatically and named in the next step; multiple require choice. An explicitly supplied unavailable Workspace must fail rather than fall back to a different one. An existing binding is reused unless an explicit target is supplied. The CLI derives a new-name suggestion from the project directory, avoids existing names case-insensitively, and caps it at 200 characters; the directory never selects an existing Cloud Brain.

After starting authorization, open/show its URL once. Respect `pollAfterMs`; after the user says approval is complete, allow a few delayed polls for the callback and token exchange before claiming it failed. Do not repeatedly ask for approval while the same live authorization is pending. Report failed/expired authorization and explicitly retry instead of polling forever.

For new Projects, first call setup with `--workspace-id ID --name NAME` to obtain the confirmation response. For existing bindings, setup reuses the binding unless a new explicit target is supplied; do not silently switch it.

## Authorization survives tool-call completion

The CLI starts a detached worker to hold the loopback callback and OAuth lock for up to three minutes. Repeated setup calls reuse that pending session. The worker stores private status and credentials under `MINDMUX_HOME` with mode `0600`, outside the project. Only the authorization URL and public status are returned; no tokens or PKCE verifier appear in the response.

For explicit inspection:

```sh
mmx login --non-interactive --status check --json
```

If the session fails/expires or its worker is terminated, explain the failure and explicitly retry:

```sh
mmx login --non-interactive --json
```

Then resume the same setup. Poll with a delay, never in a tight loop. A runtime that kills every background child cannot preserve the callback; use a persistent terminal session with `mmx login` in that environment. SSH/container/remote environments must also make the loopback callback reachable from the approving browser. Do not claim remote authorization is complete when it is not.

The same `--server URL` must be supplied when using a non-default server. Background login intentionally does not open a browser automatically. Pending authorization prevents logout or clean from erasing credentials while the worker is active; `clean --keep-login` can still reset only the project.

## Validate and hand back

```sh
mmx doctor --online --json
```

Require `healthy: true`, accessible Brain and successful MCP recall. Report the selected Project and host briefly. Ask the user to restart that host and approve project/MCP/hook trust; Codex hook trust is reviewed in `/hooks`. The installing conversation may not load new MCP tools until restart.

Setup retries reuse a known created Project. If creation returned an unknown outcome, list Projects and reconcile the target before retrying; do not blindly recreate it. Failed configuration/probes roll back project configuration while retaining a created Cloud Project and recovery information.

## Local protocol test

Only when the user explicitly requests a local Brain, add `--local` and omit Cloud selection flags. This uses the same non-interactive protocol without browser login.

For release validation, run `node scripts/verify-agent-install.mjs`. It packs and globally installs the current source in an isolated temporary prefix, drives OAuth against a local fixture, selects a Cloud Project, installs both host integrations, and runs online doctor. It simulates user approval/selection and makes no production Cloud changes. This is protocol validation, not a live-model or production OAuth test.

Question-tool reference: [Claude Code approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input). Codex experiment availability above was checked with the local CLI feature list, not assumed from a stable cross-client API.
