# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
t3 connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `t3 serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or T3 Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the T3 Connect list.
Pairing the same machine again over another address also adds a route instead
of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through T3 Connect or a paired address, T3 Code also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

T3 Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, T3 Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and T3 Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Declarative desktop connections

Managed desktop installations can provision a stable fleet without an interactive pairing step.
Give each server a stable `T3CODE_ENVIRONMENT_ID` and set `T3CODE_MANAGED_ACCESS_TOKEN_FILE` to the
path of a file holding the shared token. The server reads the file at startup and refuses to start
if it is missing, unreadable, or empty. `T3CODE_MANAGED_ACCESS_TOKEN` still accepts the token
inline, but set only one of the two. Then start the desktop app with
`T3CODE_MANAGED_CONNECTIONS_FILE` pointing to a JSON file:

```json
{
  "version": 1,
  "connections": [
    {
      "environmentId": "fleet:build-host",
      "label": "build-host",
      "httpBaseUrl": "https://build-host.example.ts.net/",
      "wsBaseUrl": "wss://build-host.example.ts.net/",
      "token": { "$file": "/run/secrets/t3code-fleet-token" }
    }
  ]
}
```

`token` is either `{ "$file": "/absolute/path" }` or the token itself. With `$file` the connections
file holds no secret and can be generated and shared freely; the desktop reads the token file on
every load, so a rotated token takes effect without editing the connections file. If any token
file is missing, unreadable, or empty, the desktop reports the error instead of loading the
catalog. An inline token makes the connections file a secret: keep it mode `0600`.

Each connection is on unless it sets `"enabled": false`. The file owns that state: the settings
switch is locked for managed connections, and every load re-applies the declared value.

The desktop catalog overlays these entries on its encrypted user-managed catalog and reconciles
removed entries on the next load. Treat the token files and server token as secrets. Use this mode
only over a trusted private network or authenticated HTTPS endpoint, and rotate the token on every
server and client together.

## Encrypted fleet enrollment

An encrypted fleet enrollment adds several machines to a phone at once. For each machine it holds
the machine's address and a reusable enrollment credential that only that machine accepts. The
phone pairs with each machine directly, and each machine issues the phone its own session. No
shared server token is included, so the ciphertext can be kept in a public Git repository.

Create a dedicated age identity for your phones and back it up in a password manager. Put its
public `age1…` recipient in an age recipients file alongside your existing SSH public keys. Keep
the `AGE-SECRET-KEY-…` identity private.

### Create a bundle

On each machine, with the same state directory and configuration as its running server, export
that machine's entry:

```sh
t3 auth enrollment export \
  --recipients-file recipients.txt \
  --output build-host.age \
  --label phones
```

The command finds the machine's own address in the fleet manifest named by
`T3CODE_FLEET_MANIFEST_FILE` or `--fleet-manifest`, matched by its `T3CODE_ENVIRONMENT_ID`:

```json
{
  "version": 1,
  "environments": [
    {
      "environmentId": "fleet:build-host",
      "label": "build-host",
      "httpBaseUrl": "https://build-host.example.ts.net/",
      "wsBaseUrl": "wss://build-host.example.ts.net/"
    }
  ]
}
```

Both URLs must be the server origin, without a base path. The command uses the standard `age`
executable, checks the recipients before creating the credential, and replaces the output only
after encryption succeeds. A failure before publication revokes its new credential and keeps any
previous output. The default lifetime is 365 days; use `--ttl` to choose a positive, finite
lifetime.

Each export decrypts to a document with one entry:

```json
{
  "version": 2,
  "type": "t3code.fleet-enrollment",
  "environments": [
    {
      "environmentId": "fleet:build-host",
      "label": "build-host",
      "httpBaseUrl": "https://build-host.example.ts.net/",
      "wsBaseUrl": "wss://build-host.example.ts.net/",
      "credential": "t3enroll1.…",
      "expiresAt": "2027-10-17T00:00:00.000Z"
    }
  ]
}
```

A bundle is the same document with every machine's entry in `environments`: at most 100 machines,
each listed once, and at most 64 KiB decrypted. To build one, export to a temporary age identity
of your own, then decrypt the exports, combine their entries, and encrypt the result to your
recipients without writing the plaintext to disk:

```sh
for file in exports/*.age; do age -d -i export-identity.txt "$file"; done |
  jq -cs '{version: 2, type: "t3code.fleet-enrollment", environments: map(.environments[])}' |
  age -e -a -R recipients.txt -o fleet.age
```

### Join on mobile

Choose **Import fleet file** when adding an environment, select `fleet.age`, and import the
backed-up age identity when prompted. Review the machines and the expiry, then choose **Join**.
The phone pairs with every machine at once and shows each one's result. A machine that is offline
or rejects its credential does not stop the others; choose **Retry** to try the failed machines
again. Joined machines are ordinary connections that you can edit or remove. A machine left out of
a newer bundle stays on the phone until you remove it.

Machines already on the phone are skipped, so importing the same bundle later joins machines that
were offline before. A machine whose session was rejected, for example after it expired, is joined
again.

age protects the file's contents but does not verify who published it, so only join machines you
expected. The phone keeps the identity in secure storage; Settings lets you import or remove it
and copy its public recipient. Decrypted enrollment data is kept in memory.

To skip choosing the file, publish `fleet.age` at an `https://` address and share it as a link.
Opening `t3code://connections/new?fleetEnrollment=<file URL>`, with the file URL
percent-encoded, downloads the file into **Add environment** (builds with their own app scheme
use that scheme). The **Add environment** scanner also accepts any web page URL carrying the same
`?fleetEnrollment=<file URL>` parameter, so one QR code can serve both the phone's camera, through
a page that opens the app, and the in-app scanner. The phone opens the file with its stored age
identity, or asks for it if none is stored. You still review the machines before joining.

### Revoke and rotate

Each machine's credential can enroll several devices until it expires or is revoked. On that
machine, list and revoke it with `t3 auth pairing list` and `t3 auth pairing revoke <id>`; the
export prints the id. Creating a new export does not revoke an older one. To rotate enrollment,
distribute a replacement bundle, then revoke the old credential on each machine. Existing device
sessions remain valid until their normal expiry or separate revocation under authorized clients.

After reinstalling the app, import the same backed-up age identity to open the existing file. A
newly generated identity cannot decrypt it until you add that identity's recipient and re-encrypt
the file. Removing a recipient only protects future ciphertext: previously published copies remain
readable by that key. If a phone is lost, revoke each machine's enrollment credential and that
phone's sessions on each machine.

Revoke active enrollment credentials before rolling a server back to a version that does not
support them; older versions cannot list their pairing records.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Connections** on the host, or on a headless host with `t3 auth session list` and
`t3 auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the T3 home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo t3 browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx t3 browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `t3` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `t3` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `T3CODE_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents T3 Code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx t3 pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`npx t3 auth pairing create` and `npx t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access and T3 Connect.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance, access
management, and T3 Connect management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. When T3 Connect rejects a host's link, the host
shows that it was removed from T3 Connect. To link it again, turn on
**T3 Connect** in **Settings → Connections** on a desktop host, or run
`t3 connect link` on a command-line host and then restart T3 Code there. A
command-line host that released its tunnel when it last stopped may link itself
again on its next start; run `t3 connect unlink` on that host to keep it off.
Removing an environment from a device's connection settings only forgets it on
that device; it stays registered to your account.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

T3 Connect also removes the tunnel of an environment running an older version of
T3 Code once it has been offline for seven days. That environment shows a message
asking you to update. Start T3 Code on that computer and update it to the latest
version; it reconnects at the same address without pairing again.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `t3 service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart T3 Code on the host.                                                                         |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update T3 Code, then restart it.                                                                            |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a
foreground server, stop it and run `t3 serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating T3 Code](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.

If a T3 Code server started with `t3 serve` already uses this computer's T3 home, the desktop app
does not start a second server. Pair with the running server under **Available on this computer**
in **Settings → Connections**. One-click pairing needs that server to run the same T3 Code version
as the desktop app; otherwise run `t3 pair` on this computer and paste the link. To pick the mode
for a single launch, start the desktop app with `--backend-mode=client-only` or
`--backend-mode=managed`.
