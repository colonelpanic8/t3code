# PR #4496 UI evidence

Captured 2026-07-24 with a controlled headless Chromium against isolated, disposable state.

- PR: https://github.com/pingdotgg/t3code/pull/4496
- PR state at capture: OPEN
- PR head at capture: `b38c6b5351592b3779d067af001c3a51d9886710`
- PR merge base (main) at capture: `38cfc25e5422e468303f2010f639cf3de9ad89ba`
- Previous PR head (before the review fix): `dcd149d34d61b8045dd0abd1146a27e3c1efd8dd`

## Setup

- Client: `apps/web` built in hosted-app mode (`VITE_HOSTED_APP_CHANNEL` set, no `VITE_HTTP_URL` /
  `VITE_WS_URL`), served as static files from a plain file server on a non-loopback LAN origin
  (`http://<lan-ip>:53595`). In this mode `isHostedStaticApp()` is true, so the client has no primary
  environment — the "client without a managed backend" case.
- Backend: `t3 serve --mode web --host 0.0.0.0 --port 53141` with a disposable `--base-dir` and a
  disposable throwaway project. Reached from the client at `http://<lan-ip>:53141`, a different origin
  from the client app.
- The client paired to that backend with the server's administrative startup token, so its session
  carries `access:write`.
- Only the `apps/web` build was swapped between commits; the same backend, browser profile, viewport
  (1440x1000), and light theme were used for every shot.

## Files

| File | Commit | Shows |
| --- | --- | --- |
| `before-main-no-access-management.png` | `38cfc25` (main) | No "Authorized clients" section at all, plus the contradictory "Administrative access — pairing links and client-session management require the access:write scope for this backend" row, even though this client paired with the server's administrative startup token. |
| `after-authorized-clients.png` | `b38c6b5` (PR head) | The section renders against the saved environment: `Create link`, `Revoke others`, a live pairing link row with its QR affordance, and per-client revoke. |
| `after-pairing-link.png` | `b38c6b5` (PR head) | The revealed pairing link and its QR resolve to the **administered backend's own origin** (`:53141`), not the client app's origin (`:53595`). |
| `review-fix-control-before-dcd149d.png` | `dcd149d` (pre-review-fix) | Control for the `resolveShareablePairingUrl` review fix: an environment with a reachable HTTP base URL. |
| `review-fix-control-after-b38c6b5.png` | `b38c6b5` (PR head) | Same state after the fix — identical rendering, only the expiry countdown differs. |

## Scope note on the review fix

`resolveShareablePairingUrl` only changes behavior when the administered environment has **no**
directly addressable HTTP origin — a relay environment, an SSH environment, or a bearer entry whose
profile is missing. Those states are not reachable from a locally runnable web client: a relay
environment needs managed-relay/cloud infrastructure to connect, and an SSH environment needs
`window.desktopBridge` (the desktop app). A bearer environment that is connected always has a base URL,
because the resolver reads it from the same profile `environmentPairingBaseUrl()` reads. That branch is
covered by unit tests in `apps/web/src/components/settings/ConnectionsSettings.logic.test.ts`; the two
control images above show the fix is a no-op for the case that *is* reachable here.

## Privacy review

- The environment label, project path, and base directory are all disposable throwaway values.
- The machine hostname is not present; the server process reported a synthetic label
  (`t3-demo-server`) so the real hostname never appeared in the UI.
- Addresses shown are an RFC1918 LAN address of a machine that is not publicly reachable.
- The pairing token in `after-pairing-link.png` is redacted in the URL text and the QR is blurred.
  The token had a 5 minute TTL, the pairing link was left to expire, and the disposable backend and
  its state directory were destroyed after capture.
