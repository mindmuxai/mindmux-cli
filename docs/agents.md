# Agent behavior and limits

[Back to README](../README.md) · [Documentation](README.md)

| Agent | Session start | User request | End of turn |
| --- | --- | --- | --- |
| Claude Code | SessionStart context, including supported resume/compaction boundaries | UserPromptSubmit retrieval and injection | One Stop review, with recursion protection |
| Codex | SessionStart hook + AGENTS.md; restores active review after compaction | UserPromptSubmit recall and pre-answer review | Stop allows a registered review; otherwise requests one recovery |
| Cursor local agent | sessionStart base context | beforeSubmitPrompt retrieval; first preToolUse delivers relevant context | One stop follow-up, with `loop_limit=1` |

Unified `setup` supports Claude Code and Codex. To install Cursor rules and hooks separately, first bind or initialize a Brain, then run:

```bash
mmx connect --agent cursor
mmx disconnect --agent cursor
```

Cursor's beforeSubmitPrompt hook is used for retrieval, not context injection. Its sessionStart hook is fire-and-forget, and preToolUse may run after the first tool's arguments have already been constructed. A turn with no tool calls depends on startup context and persistent rules. Cloud agent VMs are outside the supported scope of this local integration.

Hooks and rules encourage relevant reads and confirmed writes; configuration alone does not prove that an agent has used the knowledge. Claude Code and Codex both use startup, prompt, and Stop hooks alongside project instructions. The CLI does not run an additional LLM, read conversation transcripts, or automatically turn discussion into facts. Claude Code and Cursor may add one end-of-turn model continuation. Codex reviews memory before the final answer and registers the result locally; normal registered turns do not require a Stop continuation. A missing or failed review may still add one visible recovery and repeat the final answer. No extra LLM is run by the CLI, and these mechanisms do not guarantee that every durable fact is captured.

Brain knowledge follows the user's working language: Chinese conversations produce Chinese Page titles, knowledge and human-authored timeline descriptions; English conversations produce English knowledge, unless the user requests otherwise. English CLI prompts and repository documentation do not set the knowledge language. IDs, commands, code, URLs and verbatim evidence are preserved.

Start each Page's current knowledge with one or two plain prose sentences stating what it records, the core conclusion and when to read it, before headings, dates, provenance or lists. Put the conclusion in the first sentence and keep it current when updating the body. The existing index extracts this opening; no summary field is added. This writing guidance is delivered through installed agent rules, hook recall context and the CLI MCP service. Existing installations receive updated hook context when running the new CLI; rerun `mmx connect --agent codex` or `mmx connect --agent claude-code` to refresh the installed rules, and restart the MCP service to refresh its instructions. CLI writes preserve submitted text and do not translate or rewrite it automatically.

Codex hooks supply a review token scoped to the project, bound Brain, session and turn. The agent passes `--review-token TOKEN` to `brain create`, `update`, `append`, `archive` and `update-root`, then registers the final review:

```bash
mmx brain review --review-token TOKEN --outcome saved --reason "Saved and verified the confirmed decision"
mmx brain review --review-token TOKEN --outcome no-changes --reason "No new durable knowledge"
mmx brain review --review-token TOKEN --outcome already-covered --id PAGE_ID --reason "The existing Page covers this decision"
mmx brain review --review-token TOKEN --outcome deferred --reason "The Brain service is unavailable"
```

Use the actual token provided by the current hook. `saved` requires a successful mutation executed with that token and matching read-back versions of all recorded resources. Reading an arbitrary existing Page does not qualify as a saved write. `already-covered` checks that the referenced Page is readable; the agent remains responsible for assessing its relevance. `deferred` records a retryable failure and does not authorize Stop as a completed review. Later token-bearing writes invalidate a registered review. Direct Cloud tool calls and writes without a token cannot supply verified-write evidence; use the CLI or `mindmux_brain` facade for this workflow.

The MCP equivalent uses `mindmux_brain` with `reviewToken` on mutations, followed by `operation: "review"`, `reviewToken`, `outcome`, `reason`, and `id` for `already-covered`. Review records are local metadata, never Brain Pages. Even a no-changes turn normally needs one local tool call. The review proves workflow completion, not that the agent's knowledge judgment is complete.

Review tokens expire after 24 hours and are invalidated when the active turn or binding changes, on interruption, and when Stop closes the turn. Exact completed-review retries are idempotent until the next turn or expiry. Missing session/turn identifiers disable enforcement with `review-unavailable` diagnostics rather than reusing a default session. Compaction restores the active token and registration state. Session locks serialize state updates and write verification; a busy or abandoned lock fails with a diagnostic rather than being removed while another process may be using it. After confirming a crashed process is gone, remove its `.mindmux/cli/reviews/*.lock` directory to retry. Review state is ignored by Git and removed by `mmx clean`.

Upgrade existing Codex installations with `mmx connect --agent codex` or `mmx doctor --fix`, restart Codex and review `/hooks`. The managed installation also handles interruption to invalidate the active review. Claude Code and Cursor retain their existing Stop behavior.

`doctor` checks files, executable paths, and recent hook receipts:

- `retrieved`: retrieval completed, awaiting delivery.
- `emitted`: context returned through the hook protocol; adoption by the model is not established.
- `review-requested`: one recovery requested for an unregistered Codex review, or the regular end-of-turn review for other agents.
- `review-registered` / `review-completed`: a local review was registered / accepted by Stop.
- `review-failed` / `recovery-exhausted`: review or persistence failed; one recovery could not complete it. No claim of saved memory is made.
- `review-unavailable` / `review-expired` / `review-aborted`: enforcement lacks a valid active turn, the token expired, or the turn was interrupted.
- `error` / `timeout`: a failure or the eight-second hook budget was exceeded. The task continues without switching Brains.

Retrieval starts with the Brain index: Page IDs, titles, summaries, categories, lifecycle states and tags, plus root-page navigation. The hook receives a bounded preview of complete index rows, with an explicit `brain index` instruction when rows are omitted; there is no fixed 20-page cutoff. Keyword retrieval supplements this directory with up to three active Page bodies and two core roots within an 8 KiB UTF-8 budget. A zero-length `pageIds` means no Page body was selected, not that the index is empty. The agent should read relevant Pages identified from the index even when keyword matching returns nothing. Local and Cloud full-text matches remain candidates even when their short summaries do not repeat the query. Vector retrieval and semantic reranking are not implemented.

`brain index` returns a current active-page navigation view as `body`, structured `pages`, `rootPages`, and `count`. Local reads report whether the actual `brain/index.md` file is present. That canonical brain.md file may contain explicitly labeled draft/archived entries; its raw contents are not exposed through the active index API or hooks. Local `brain reindex` uses brain.md's generator to rebuild that file. Page writes continue to maintain the local index through brain.md.

Cloud reads use `read_brain_index`; `reindex_brain` regenerates and persists a derived Markdown snapshot. Reads expose saved snapshot cursor/staleness metadata, never obsolete snapshot text. The main `body` is generated from current source Pages so a saved snapshot never overrides current truth. Indexes are generated documents: edit source Pages, then regenerate rather than supplying arbitrary index text. The Cloud service needs migration `0028_brain_indexes.sql` and the updated MCP server before the new Cloud index tools are available. For an older Cloud server without `read_brain_index`, the CLI builds the same navigation view from Cloud `list_pages` and `list_root_pages`, retaining summaries and marking `source: page-list-compatibility`. A failed supported index read is propagated; no local Brain fallback occurs.

Raw user prompts are not persisted. Session retrieval caches under `.mindmux/cli/sessions/` contain Brain content and are ignored by Git, with mode `0600`. Pending Cursor delivery expires after ten minutes; changing a binding invalidates reuse. Historical cache cleanup is manual.

Managed instruction blocks and hook registration are idempotent. Disconnect removes owned entries while preserving user content, Brain data, other hooks, and skills. Malformed configuration or markers cause an error rather than being overwritten. `doctor` reports recognized duplicate brain.md integrations; use the original installer to remove older hooks or global skills when replacing them.

### Updating current knowledge

Agent rules, hook recall and MCP instructions require whole-Page replacement when current facts or requirements change. Read the full Page, preserve unrelated content, and remove obsolete claims from its current body. A Timeline note alone does not update knowledge.

Use `--change-kind substantive --summary "Why it changed"` for durable changes (the type is the default for older commands). For Cloud typos, formatting or erroneous initial content, use `--change-kind correction` without `--summary`/`--source`; it preserves the Timeline. Local brain.md updates still require a summary and record a Timeline entry. Use `append` only for independent evidence or events. The `mindmux_brain` tool exposes the same choice as `changeKind`.

After updating the CLI, rerun `mmx connect --agent codex` or `mmx connect --agent claude-code` to refresh existing managed rules and restart the MCP service. Hooks use the installed CLI's current recall guidance. No reset or Cloud data cleanup is needed.
