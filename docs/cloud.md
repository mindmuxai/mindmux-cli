# Cloud login and binding

[Back to README](../README.md) · [Documentation](README.md)

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
