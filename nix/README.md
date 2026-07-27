# Nix packaging

`flake.nix` at the repository root provides:

- `nix develop` — a dev shell with the pinned Node and pnpm, plus
  `ELECTRON_OVERRIDE_DIST_PATH` so Electron does not try to download a binary.
- `nix build` — the desktop app built from this checkout.
- `packages.<system>.client` — the same package with a client-only desktop
  launcher and Secret Service password storage on Linux.
- `overlays.default` and `overlays.client` — overlays selecting the normal or
  client package as `pkgs.t3code`.
- `homeManagerModules.t3code-server` — a cross-platform persistent backend
  service using systemd on Linux and launchd on macOS.
- `nix develop .#android` — the Android SDK, NDK, JDK, Node, CMake, and Zig
  development environment on Linux.
- `nix run .#build-android` — a reproducible writable-copy build of a
  sideloadable Android release APK.

The source build is exposed for `x86_64-linux`, `aarch64-linux`, and
`aarch64-darwin`. Current nixpkgs no longer supports `x86_64-darwin`; use the
release-artifact flake described below if Intel macOS support is required.

## How the package is built

Rather than re-deriving the whole Electron + pnpm monorepo build, the flake
overrides nixpkgs' existing `t3code` derivation with `src = self`. That keeps
this file small and means upstream packaging fixes are inherited automatically.

This is deliberately different from
[`Sawrz/t3code-nix`](https://github.com/Sawrz/t3code-nix), which packages
published desktop and npm artifacts. That flake is useful for installing a
released T3 Code version; this one builds and tests the source in the current
checkout.

The desktop file and icons come from nixpkgs's official `t3code` derivation.
The client package wraps the executable those entries already launch, so it
does not duplicate or patch desktop files.

The build runs the desktop dependency chain directly (web → server → Electron
shell) instead of `vp run`, because the Vite+ task runner walks every declared
workspace and tries to install the mobile and infrastructure workspaces, which
are intentionally not fetched.

## Refreshing the dependency hash

`pnpmDeps.hash` is a fixed-output hash over the offline dependency closure. It
must be refreshed whenever `pnpm-lock.yaml` changes:

1. Set `hash = pkgs.lib.fakeHash;` in `flake.nix`.
2. Run `nix build .#unwrapped`.
3. Copy the `got:` hash from the error into `flake.nix`.

A mismatched hash fails the build loudly rather than silently using a stale
closure, so this is safe to forget until the lockfile actually moves.

## Scope

This is packaging only — it does not change application code or affect the
normal `pnpm` workflow.
