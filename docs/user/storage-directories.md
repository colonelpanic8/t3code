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
configuration directory. Attachments, worktrees, and saved browser screenshots
(the server's and the desktop app's alike, pruned together) live in the data
directory. The SQLite database, identity, secrets, and logs live in the state
directory. Provider status caches live in `provider-status/` in the cache
directory. Live-server discovery state lives in the runtime directory. The
desktop app keeps its own files in [separate directories](#desktop-app-storage).

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
the old unified layout beneath the supplied directory. `T3CODE_HOME` cannot be
combined with the overrides above, since neither variable can tell which one
you meant. `--base-dir` on the command line wins over them, so a one-off
`t3 --base-dir <dir>` still works in a shell that inherited them, such as one a
background service started.

The server location overrides from [Install](./install.md#where-the-server-keeps-its-files),
`--server-config-dir`, `--server-data-dir`, and `--server-cache-dir` (or their
`T3CODE_SERVER_*_DIR` variables), work in both layouts and win over the layout's
directory for their files. In the split layout a data directory override also
takes the state directory's files and the runtime file, as the data directory
holds all of them in the legacy layout, so a second server with its own data
directory never mistakes the first for itself. They can be combined with
`T3CODE_HOME`. If one of them and a root override above name different
directories for the same files, for example `T3CODE_SERVER_DATA_DIR` and
`T3CODE_STATE_DIR`, the server refuses to start rather than pick one.

A background service records the split directories it was installed with,
except the runtime directory, which follows the service manager's
`XDG_RUNTIME_DIR` on Linux. Development servers use their own `t3code-dev` directories in
the split layout, where the legacy tree used `~/.t3/dev`.

Use `--storage-layout xdg` to force the platform-native split layout, even when
an initialized legacy installation exists or `T3CODE_HOME` is set. Use
`--storage-layout legacy` to force the legacy tree, `T3CODE_HOME` or else
`~/.t3`, even when it has not been initialized, ignoring the overrides above.
`xdg` cannot be combined with `--base-dir`.

## Desktop app storage

With the split layout, the desktop app keeps its own files apart from any
server's, so a desktop that only connects to other servers never writes into a
server's directories. On Linux, the defaults are:

| Purpose       | Default                                               | Holds                                                                                         |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/t3code-client`     | Desktop and client settings                                                                   |
| State         | `${XDG_STATE_HOME:-$HOME/.local/state}/t3code-client` | Window state, saved connections and their credentials, sign-in tokens, Electron profile, logs |
| Cache         | `${XDG_CACHE_HOME:-$HOME/.cache}/t3code-client`       | Disposable desktop caches                                                                     |

On macOS they live in `~/Library/Application Support/t3code-client` and
`~/Library/Caches/t3code-client`, again without the XDG variables. On Windows
they live in `%APPDATA%\t3code-client` and `%LOCALAPPDATA%\t3code-client`.
Override them with `T3CODE_CLIENT_CONFIG_DIR`, `T3CODE_CLIENT_STATE_DIR`, and
`T3CODE_CLIENT_CACHE_DIR`. The server's root and location overrides do not
move them. In the legacy layout all of these files stay in `~/.t3/userdata`.

A [client directory](./install.md#where-the-desktop-app-keeps-its-files)
relocates only the desktop's settings and small state files, in either layout.
The sign-in tokens, Electron profile, logs, and caches stay in the directories
above.

Desktop builds that used the split layout before these directories existed kept
the same files in the server's configuration and state directories. T3 Code
does not move them. To keep your desktop settings, saved connections, and
browser profile, quit the app and copy them into the directories above.

## Existing installations

If the split directories already hold a server's state, T3 Code uses them.
Otherwise, if it finds an installation under `~/.t3`, it keeps using that
layout. When both exist, the server uses the split directories and logs a
warning naming the `~/.t3` it ignores. If either location cannot be checked,
for example because of its permissions, the server refuses to start rather than
guess. Startup does not copy, move, delete, or automatically switch any data.
An SSH connection from the desktop app uses a remote's split directories when
they already hold a server's state or the remote's `~/.t3` was migrated, and
`~/.t3` on the remote otherwise.

### Moving to the split layout

Older T3 Code versions ignore the migration and keep using `~/.t3`, so first
update every T3 Code install on the machine: the desktop app, the `t3` command,
and any background service. Then stop the server, quit the desktop app, and
run:

```bash
t3 storage migrate --dry-run
t3 storage migrate
```

The dry run lists every copy, what stays behind and why, and anything that
blocks the migration. The migration copies the database and files into the
server and [desktop](#desktop-app-storage) directories and verifies each copy
before switching anything over, then writes `storage-migration.json` into
`~/.t3/userdata`, which retires that tree. Nothing under `~/.t3` is moved or
deleted. If the migration is interrupted, T3 Code keeps using `~/.t3`, and the
next run cleans up and starts over. Worktrees stay where they are because
threads refer to them by path, and logs stay with the old tree. A file or
folder in `~/.t3/userdata` that is a symbolic link is recreated as a link. One
that points elsewhere, such as settings kept in a dotfiles repository, keeps
its target; one that points into `~/.t3/userdata` points at the migrated copy
instead. If a destination already holds different contents, the migration
stops; `--replace-existing` moves those files aside first. Only one migration
or rollback runs at a time.

A background service installed with `t3 service install` keeps serving the tree
it was installed for, so the migration refuses to run while one serves
`~/.t3`. Run `t3 service uninstall`, migrate, then `t3 service install`. The
desktop app points an installed `t3` command at its new launcher the next time
it starts.

Files a server location override or a client directory keeps elsewhere stay
put, because that copy is already the one T3 Code reads in either layout. Run
the migration with the same `T3CODE_SERVER_*` and `T3CODE_CLIENT_DIR`
variables the server and desktop use, or pass `--server-config-dir`,
`--server-data-dir`, `--server-config-file`, and `--client-dir`.

`t3 storage migrate --rollback` returns to the old tree. It moves the copies
aside rather than deleting them, and does not copy back anything written since
the migration; reinstall a background service around it the same way. A `t3`
command pointed at a retired tree with `T3CODE_HOME`, `--base-dir`, or
`--storage-layout legacy` refuses to run until you unset it or roll back.
