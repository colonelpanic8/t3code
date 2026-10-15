# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

This installs the `t3` binary to `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                      |
| Start the server without a browser               | `t3 serve`                                                |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md)) |
| Move to the newest release                       | `t3 update`                                               |
| Remove it again                                  | `t3 uninstall`                                            |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

To try T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`).

### Where the server keeps its files

The server keeps everything under its T3 home, `~/.t3` by default. Set
`--base-dir` or `T3CODE_HOME` to move all of it. To move one kind of file on its
own, for example to keep configuration in a dotfiles repository or the database
on another disk, set any of these. Each falls back to its usual place in the T3
home when unset, and none moves the others.

| Files                                                                      | Flag                  | Environment variable       | Default          |
| -------------------------------------------------------------------------- | --------------------- | -------------------------- | ---------------- |
| `settings.json`, `keybindings.json`, `themes/`                             | `--server-config-dir` | `T3CODE_SERVER_CONFIG_DIR` | `~/.t3/userdata` |
| Database, secrets, attachments, logs, `worktrees/`, and other server state | `--server-data-dir`   | `T3CODE_SERVER_DATA_DIR`   | `~/.t3/userdata` |
| Provider status caches                                                     | `--server-cache-dir`  | `T3CODE_SERVER_CACHE_DIR`  | `~/.t3/caches`   |

New worktrees go in `worktrees/` inside the data directory when you set one,
and in `~/.t3/worktrees` otherwise. Model and usage caches live in the data
directory too, so they move with it. Existing files are not moved for you: stop
the server and move them yourself before pointing it at a new location.

Setting or changing a data directory signs every browser out once, since login
sessions are tied to where the server keeps its data. The desktop app keeps its
own saved browser screenshots in `~/.t3/userdata/browser-artifacts`, and a
server with a data directory does not clean those up.

Use absolute paths in these variables. A relative value is resolved against the
working directory of each process that reads it, which differs between your
shell and the desktop app.

These settings outrank `--base-dir` and `T3CODE_HOME`. While one is exported,
a different `--base-dir` does not give you an independent server; unset them
for that.

Commands that work with a server's files, such as `t3 pair`, `t3 auth`,
`t3 project`, `t3 theme`, and `t3 connect`, need the same settings as the server
to find it; the environment variables are the easiest way to share them. The
background service records only the T3 home, so `t3 service`, `t3 update`, and
`t3 uninstall` ignore these settings and use the T3 home's usual locations.
Set them in the service's environment yourself if it should use them.

### Server options file

Server options can also live in a JSON file, which is easier to keep in a
dotfiles repository or generate than a list of flags. The server reads
`server.json` in its config directory, `~/.t3/userdata/server.json` by default.
To read another file, set `--server-config-file` or `T3CODE_SERVER_CONFIG_FILE`;
a file named this way must exist. The server reads the file once at startup, so
restart it after editing.

```json
{
  "host": "0.0.0.0",
  "port": 3773,
  "tailscaleServeEnabled": true,
  "logLevel": "Debug"
}
```

Every key is optional. A flag wins over its environment variable, and both win
over the file. When the desktop app starts the server, the mode, port, host,
network access, and browser setting it passes also win over the file.

| Key                                              | Same as                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `port`                                           | `--port`, `T3CODE_PORT`                                       |
| `host`                                           | `--host`, `T3CODE_HOST`                                       |
| `mode`                                           | `--mode`, `T3CODE_MODE`                                       |
| `noBrowser`                                      | `--no-browser`, `T3CODE_NO_BROWSER`                           |
| `tailscaleServeEnabled`                          | `--tailscale-serve`, `T3CODE_TAILSCALE_SERVE`                 |
| `tailscaleServePort`                             | `--tailscale-serve-port`, `T3CODE_TAILSCALE_SERVE_PORT`       |
| `logLevel`                                       | `--log-level`, `T3CODE_LOG_LEVEL`                             |
| `logWebSocketEvents`                             | `--log-websocket-events`, `T3CODE_LOG_WS_EVENTS`              |
| `traceFile`                                      | `T3CODE_TRACE_FILE`                                           |
| `traceMinLevel`                                  | `T3CODE_TRACE_MIN_LEVEL`                                      |
| `traceTimingEnabled`                             | `T3CODE_TRACE_TIMING_ENABLED`                                 |
| `traceBatchWindowMs`                             | `T3CODE_TRACE_BATCH_WINDOW_MS`                                |
| `traceMaxBytes`                                  | `T3CODE_TRACE_MAX_BYTES`                                      |
| `traceMaxFiles`                                  | `T3CODE_TRACE_MAX_FILES`                                      |
| `otlpTracesUrl`, `otlpMetricsUrl`, `otlpLogsUrl` | `T3CODE_OTLP_TRACES_URL`, `_METRICS_URL`, `_LOGS_URL`         |
| `otlpProtocol`                                   | `T3CODE_OTLP_PROTOCOL`                                        |
| `otlpHeaders`                                    | `T3CODE_OTLP_HEADERS`, as an object of header names to values |
| `otlpExportIntervalMs`                           | `T3CODE_OTLP_EXPORT_INTERVAL_MS`                              |

Log levels are spelled as for the environment variables: `Trace`, `Debug`,
`Info`, `Warn`, `Error`, `Fatal`, `All`, or `None`. A relative `traceFile` is
relative to the file's directory. The file cannot say where the server keeps
its files. Those locations come only from the flags and environment variables
above, so the `t3` commands and the SSH launcher always find a running server
from its T3 home.

An OpenTelemetry endpoint in the file is sent the file's `otlpProtocol` and
`otlpHeaders` only. Endpoints from environment variables win over the file's,
and the file's win over endpoints saved in
[Diagnostics settings](./telemetry.md#export-diagnostics-to-your-own-receiver).
The desktop app passes the endpoints saved there to the server it starts, so in
the desktop app they win over the file.

A value of the wrong type stops the server with an error naming the file and
the key. `t3 auth`, `t3 project`, and `t3 connect` read the file too, so they
fail with the same error. Keys the server does not know are skipped with a
warning in its log. `t3 trace summary` uses the file's trace settings, and
`t3 triage` reports a broken file instead of stopping. The background service
reads `server.json` from `userdata` in its T3 home. `t3 service`, `t3 update`,
and `t3 uninstall` never read the file, so a broken one does not stop you from
managing the install.

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                            |
| ------------------ | ---------------------------------- |
| Windows            | `winget install T3Tools.T3Code`    |
| macOS              | `brew install --cask t3-code`      |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb` |
| Arch Linux         | `yay -S t3code-bin`                |
| Arch Linux nightly | `yay -S t3code-nightly-bin`        |

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `t3` command

The desktop app includes the `t3` command-line tool. To run it from any
terminal, open **Settings → General → About** and choose **Install** next to
**t3 command**. On macOS and Linux it adds a `t3` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again. If you already have `t3`
from npm, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

Nightly builds need the beta app. The store apps cannot connect to them. A Nightly build also
shows these links as QR codes in **Settings → General → Mobile app**.

- **iPhone and iPad:** join the [TestFlight beta](https://testflight.apple.com/join/XgaxaRtd).
- **Android:** join the [beta group](https://groups.google.com/g/t3-code-v2-beta). With the same
  Google account, open the [Google Play testing page](https://play.google.com/apps/testing/com.t3tools.t3code)
  and become a tester.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3 Code. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md), and
[Muse Code](./providers-muse.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
