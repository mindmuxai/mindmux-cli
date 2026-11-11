# Brain and MCP commands

[Back to README](../README.md) · [Documentation](README.md)

Brain commands return JSON by default.

```bash
mmx brain status
mmx brain index                    # Read the generated active-page index and root navigation.
mmx brain reindex                  # Rebuild the derived index; requires write access.
mmx brain list
mmx brain search 'authentication'
mmx brain recall 'implement authentication'
mmx brain read auth-pkce

cat decision.md | mmx brain create \
  --id auth-pkce --title 'Use OAuth PKCE for authentication' \
  --category decision --source 'Confirmed in the design review'

cat revised.md | mmx brain update auth-pkce \
  --expected-version <version-from-read> --change-kind substantive \
  --summary 'Restrict the callback to loopback' --source 'Design review'

# Cloud-only correction: replace erroneous content without adding a Timeline entry.
cat corrected.md | mmx brain update auth-pkce \
  --expected-version <version-from-read> --change-kind correction

mmx brain append auth-pkce --kind evidence --summary 'Interoperability verified' --source 'Test report'
mmx brain archive auth-pkce
mmx brain roots
mmx brain read-root architecture
cat architecture.md | mmx brain update-root architecture --expected-version <version-from-read>
```

Read the current version before updating. Local versions are file SHA-256 hashes; Cloud versions are positive server-side integers. Conflicts are not overwritten or retried automatically. For a new root, pass `--expected-version new`; existing roots require their current version.

`update` replaces the entire current Page body; read the full Page first and preserve unrelated content. When a requirement is removed or reversed, remove it from current content rather than only adding a conflicting Timeline note. `append` is for independent evidence or events that do not change current content.

`--change-kind substantive` is the default, preserving existing commands, and requires `--summary` (with optional `--source`). The content replacement and one Timeline entry are atomic. Cloud `--change-kind correction` is for typos, formatting or erroneous initial content: omit both `--summary` and `--source`; the Timeline is unchanged. Invalid combinations fail without an update request. Local brain.md does not support Timeline-free correction: use the default update with a concise correction summary.

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

The additional `mindmux_brain` tool supports local and Cloud status, index, reindex, list, search, recall, read, create, update, append, archive, roots, read-root, update-root, and review operations. Bodies pass through stdin without shell interpolation. Cloud `isError`, content, and structured content are preserved. Restart the MCP service after changing a binding.

For `mindmux_brain` updates, use `changeKind: "substantive"` with `summary`, or Cloud `changeKind: "correction"` without `summary`/`source`. `body` is always the complete replacement content and `expectedVersion` is the string version returned by `read`. Omitting `changeKind` keeps the default substantive behavior. Raw `update_compiled_truth` calls use Cloud field names (`compiledTruth`, numeric `expectedVersion`, and `timelineEntry` for substantive updates).
