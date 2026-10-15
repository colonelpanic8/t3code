# Storage directories

New T3 Code installations keep configuration, durable data, machine state,
disposable caches, and process-lifetime files in separate directories.

On Linux, the default roots are:

| Purpose       | Default                                                       |
| ------------- | ------------------------------------------------------------- |
| Configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/t3code`                    |
| Data          | `${XDG_DATA_HOME:-$HOME/.local/share}/t3code`                 |
| State         | `${XDG_STATE_HOME:-$HOME/.local/state}/t3code`                |
| Cache         | `${XDG_CACHE_HOME:-$HOME/.cache}/t3code`                      |
| Runtime       | `$XDG_RUNTIME_DIR/t3code`, with a per-user temporary fallback |

Settings, keybindings, `server.json`, and published themes live in the
configuration directory. Attachments and worktrees live in the data directory.
The SQLite database, identity, secrets, and logs live in the state directory.
Provider status caches live in `provider-status/` in the cache directory, next
to desktop browser artifacts. Live-server discovery state lives in the runtime
directory.

On macOS they live in `~/Library/Application Support/t3code` and
`~/Library/Caches/t3code`, and the XDG variables are not used, because an app
started from the Finder never sees a shell's environment. On Windows they live
in `%APPDATA%\t3code` and `%LOCALAPPDATA%\t3code`.

The effective paths for the connected server are shown under **Settings →
Diagnostics → Storage Locations**.

## Overrides

Each root can be overridden independently:

- `T3CODE_CONFIG_DIR`
- `T3CODE_DATA_DIR`
- `T3CODE_STATE_DIR`
- `T3CODE_CACHE_DIR`
- `T3CODE_RUNTIME_DIR`

This lets a machine-local environment point the configuration root at a
dotfiles checkout while keeping durable data, state, caches, and runtime files
in host-local directories.

`T3CODE_HOME` and `--base-dir` are legacy compatibility controls. They select
the old unified layout beneath the supplied directory and cannot be combined
with the granular overrides.

The server location overrides from [Install](./install.md#where-the-server-keeps-its-files),
`--server-config-dir`, `--server-data-dir`, and `--server-cache-dir` (or their
`T3CODE_SERVER_*_DIR` variables), work in both layouts and win over the layout's
directory for their files. In the split layout a data directory override also
takes the state directory's files, as the data directory holds both in the
legacy layout; the runtime directory stays put. They can be combined with
`T3CODE_HOME`. If one of them and a root override above name different
directories for the same files, for example `T3CODE_SERVER_DATA_DIR` and
`T3CODE_STATE_DIR`, the server refuses to start rather than pick one. Since a
data directory override leaves the runtime directory alone, two servers that
differ only in their data directory share one runtime file and cannot tell
which is running; give each its own `T3CODE_RUNTIME_DIR` as well.

A background service records the split directories it was installed with,
except the runtime directory, which follows the service manager's
`XDG_RUNTIME_DIR` on Linux.

Use `--storage-layout xdg` to force the platform-native split layout, even when
an initialized legacy installation exists. Use `--storage-layout legacy` to
force the default legacy tree under `~/.t3`, even when it has not been
initialized. These values override automatic layout selection; `xdg` cannot be
combined with `T3CODE_HOME` or `--base-dir`, and `legacy` cannot be combined
with granular directory overrides.

## Existing installations

If the split directories already hold a server's state, T3 Code uses them.
Otherwise, if it finds an installation under `~/.t3`, it keeps using that
layout. When both exist, the server uses the split directories and logs a
warning naming the `~/.t3` it ignores. If either location cannot be checked,
for example because of its permissions, the server refuses to start rather than
guess. Startup does not copy, move, delete, or automatically switch any data.
