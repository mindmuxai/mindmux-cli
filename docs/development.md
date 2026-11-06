# Development and verification

[Back to README](../README.md) · [Documentation](README.md)

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
