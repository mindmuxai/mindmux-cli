# Machine interface

[Back to README](../README.md) · [Documentation](README.md)

## Discover commands offline

```sh
mmx schema
mmx schema brain update
mmx schema setup
```

These commands always return JSON. They work before setup/login, even with a nonexistent `--project` path, and do not access the network or create files. `schemaVersion` identifies the discovery contract; `cliVersion` identifies the installed implementation. The catalog describes command effects. Detailed Brain schemas define field types, required fields, conditional requirements, stdin and CLI flag mappings. Other command entries describe available flags and workflow notes; they do not model every interactive selection or service-side constraint.

Brain input schemas use MCP-style field names: for example, `expectedVersion` maps to `--expected-version`. `cli.positional` identifies positional input; `body` goes through stdin as complete Markdown, not as a flag or JSON-escaped string. `cli.stdin.maxBytes` is the input byte limit. Cloud Page versions are positive integers passed as strings; local versions are hashes. Root creation uses `new`.

For Page updates, `changeKind` defaults to `substantive`, which requires `summary`. A Cloud `correction` must omit both `summary` and `source`; local Brain does not support Timeline-free correction. The MCP facade and CLI discovery share Brain field definitions. CLI validation runs before Brain access or waiting for stdin.

`mmx --skill` remains the portable prose guide. It teaches the workflow; schema discovery supplies exact parameters for the installed version. User-only automatic-memory controls are deliberately omitted from Agent discovery, the Skill and MCP tools.

## JSON errors

Add `--json` for structured command errors. `--non-interactive` and its exact `-agent` alias imply JSON. Success payloads remain compatible with earlier versions; they are not wrapped in a new envelope.

```json
{
  "status": "error",
  "error": "Version conflict or missing --expected-version. Read the current page before updating.",
  "code": "VERSION_CONFLICT",
  "retryable": false,
  "outcome": "not-started",
  "next": "Read the complete current page, reconcile changes and update using its returned version."
}
```

Errors exit with status 1; normal results and intermediate setup states such as `input_required` exit 0. Error JSON is written to stdout; diagnostics/progress, when present, use stderr. The legacy `error` string and setup `installed`, `stage`, `next` and recovery information are retained. The top-level failure handler also retains `installed: false` for compatibility; it is not an installation-health diagnosis.

| Code | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | Invalid CLI flags, required Brain fields, conditional arguments or stdin |
| `PROJECT_UNAVAILABLE` | The requested project path cannot be resolved |
| `BRAIN_UNBOUND` | No explicit Brain selection exists |
| `AUTH_REQUIRED` | CLI Cloud authorization is required |
| `VERSION_CONFLICT` | A local write's expected version differs from current content |
| `UPSTREAM_ERROR` | Cloud returned a tool error; `upstreamCode` retains its structured code if provided |
| `CLI_SUBPROCESS_FAILED` | The MCP facade's CLI process failed without a structured response |
| `WRITE_FAILED` / `COMMAND_FAILED` | Other failures; inspect the message and `next` |

Do not infer a specific cause by matching an English error message. Unknown upstream errors remain unknown. `retryable: false` means the Agent must not blindly repeat the call; it does not mean the user can never recover. In particular, `outcome: "unknown"` does not establish whether a write occurred. Read the target and reconcile before repeating creates, updates or Timeline appends. No mutation is automatically replayed.

`not-started` indicates the requested effect did not start at the reported validation/check point. Multi-step operations can retain an unknown outcome even when a later check failed. A failed post-write verification must not be reported as an unsaved write or as success.

Hook stdout uses the host's native schema, and `mcp serve` stdout is exclusively MCP protocol. Help, version and successful `--skill` output keep their text formats. The MCP `mindmux_brain` facade carries command error JSON in its error text content; original Cloud tools retain their native MCP result format.
