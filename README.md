# PR #4444 final-package evidence

Captured 2026-07-24 in an isolated hidden X11 desktop.

- PR: https://github.com/pingdotgg/t3code/pull/4444
- PR state at capture: OPEN
- PR head at capture: `bb2c567e6879cf762910a02a8d20943edc2689ce`
- PR base at capture: `ece05087a70e94efcd57441337fa1249559362ba`
- Combined-stack integration commit used for the package: `5ba3b7bd0995f401993706689105f41f51c16b02`
- Exact package: `/nix/store/86n9kxipsprgw6nbzyw7qhrw0wl4lfwx-t3code-0.0.29-patched-main-20260724`
- Launch mode: packaged Electron app with `--backend-mode=client-only`
- Independent backend: the exact package's `t3 serve`, bound to loopback on a disposable high port
- Client and backend used separate disposable XDG state/config/data/cache directories under `/dev/shm`
- Credential storage: a disposable GNOME Secret Service keyring inside the isolated DBus session

Verified:

1. The packaged Electron app started in client-only mode without starting or owning a local backend.
2. The packaged renderer assets resolved successfully from the installed app-relative path.
3. With no saved environment, the app displayed the environment-first empty state.
4. Settings > Connections explained that the desktop process does not start or control a local backend and showed the active CLI override.
5. Manual remote-link pairing to the independently started backend succeeded.
6. The saved environment appeared online in Settings > Connections.
7. Returning home after pairing displayed the normal project-first empty state.

Privacy review:

- Pairing code and ephemeral credentials are absent from the retained screenshots.
- All project and XDG paths were disposable.
- The connected environment label is the test machine hostname (`jay-lenovo`).

Retained screenshots:

- `startup-clean.png`
- `connections-settings.png`
- `after-pair.png`
- `connected-home.png`

Subsequent stack state:

- After these screenshots were captured, the maintained dotfiles stack advanced
  its upstream base to `41a430a88e8dde9c428f59d54dd328aa6a66a8fd`.
- The intervening upstream delta was isolated to PR #4472 model registration;
  it did not overlap this desktop client-only change.
- The resulting final package
  `/nix/store/brp90sqhjxnnpczsnw9nmp1rlzi0qjgk-t3code-0.0.29-patched-main-20260724`
  built and activated successfully.
- The screenshots above remain specifically attributable to the earlier exact
  package and synthetic integration commit identified near the top of this
  manifest; they are not represented as a GUI recapture of the later package.
