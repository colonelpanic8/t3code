# Android stack build

`.github/workflows/android-stack-build.yml` builds an installable APK from a fork without
EAS. Upstream's `mobile-eas-*.yml` workflows need `pingdotgg`'s `EXPO_TOKEN` and
`blacksmith-*` runners, so they cannot run on a fork; this workflow uses a GitHub-hosted
runner and pins the Android toolchain with Nix instead.

It runs on `workflow_dispatch` (choose the app variant) and on pushes to `t3code/stack`.
To make it manual-only, delete the `push:` trigger.

No secrets or repository variables are required.

Each run publishes a GitHub release tagged `android-stack-<variant>-<date>-<sha>`. That tag
namespace is deliberate: the `release.yml` inherited from upstream triggers on `v*.*.*`, and
its `blacksmith-*` runners do not exist on a fork, so a `v` tag would queue a desktop
release job forever.

## Size

Only `arm64-v8a` is packaged, via the template's own `reactNativeArchitectures` property.
That drops 91MB of native libraries: `x86` and `x86_64` are emulator-only and `armeabi-v7a`
only matters for pre-2017 devices. **The published APK therefore will not install on a
standard x86_64 Android emulator** — emulator testing needs its own build.

R8 minification is deliberately left off. It would roughly halve the ~71MB of `classes*.dex`,
but R8 can strip reflection-reached code in React Native and native modules, and the
resulting crashes do not show up in a green build.

## Versioning

`app.config.ts` pins version `0.1.0` and never sets `android.versionCode`, so every build
would be version code 1 and an F-Droid index rejects duplicates. The workflow patches the
_generated_ `android/app/build.gradle` with a version code derived from the commit
timestamp (minutes since 2020-01-01 UTC), which is monotonic with history and stays well
below the 2100000000 ceiling. Patching the generated file rather than `app.config.ts` keeps
this out of a file shared with upstream and with EAS builds.

## F-Droid repository

`.github/workflows/fdroid-repo.yml` indexes the APKs from recent
`android-stack-preview-*` releases into a self-hosted F-Droid repository at
<https://colonelpanic8.github.io/t3code/>, so a phone gets stack builds as ordinary app
updates. It runs automatically after a successful Android Stack Build, and on
`workflow_dispatch`.

APKs are indexed as published rather than rebuilt, so an install from the repo and an
install from the releases page share a signature and upgrade in place from each other.

The repo tracks the `preview` variant only. Other variants have a different application id,
which `fdroid update` rejects for having no metadata file.

Configuration lives in `fdroid/config.yml` and `fdroid/metadata/`, the listing in
`fastlane/metadata/android/` (the layout F-Droid, IzzyOnDroid, and Play all read), and the
collection logic in `scripts/fdroid/build-repo.sh`.

### Index signing

The index is signed with a key that is **unrelated to the APK signing key**, because the
APKs are signed with the Expo template's public debug keystore, which nobody should trust
as a repository identity. Four secrets are set on the fork: `FDROID_KEYSTORE_BASE64`,
`FDROID_KEY_ALIAS`, `FDROID_KEYSTORE_PASSWORD`, `FDROID_KEY_PASSWORD`.

The keystore and its password are also kept in `pass` under
`fdroid/t3code-index-keystore`. Losing it changes the repository fingerprint, and every
client then has to remove and re-add the repo.

Clients pin a repository by the SHA-256 of that certificate, so the address to hand out is
`<repo_url>?fingerprint=<fingerprint>`. The deployed landing page prints the full address,
and each run puts it in the job summary.

## Signing

`./gradlew assembleRelease` is signed with the `debug.keystore` the Expo template ships,
because `android/app/build.gradle` points the release `signingConfig` at it. That keystore
is part of the template rather than generated per machine, so the signature is identical on
every run and a new build upgrades an existing install in place instead of forcing an
uninstall. It is not a secret and must never be used for a store release.

## Toolchain

The workflow does not define its own toolchain. It uses the `android` dev shell already in
this branch's `flake.nix`, which is the same shell used to build APKs locally:

```bash
nix develop .#android
nix run .#build-android    # the local equivalent of this workflow
```

Keeping one definition matters because the versions are not obvious. Gradle cannot install
a missing SDK component into the read-only Nix store, so everything the build asks for must
be declared up front, and two independent sets of versions are in play — which is why the
shell lists ranges (`buildToolsVersions = ["36.0.0" "35.0.0" "34.0.0"]`, two NDKs) rather
than single pins:

- **Expo's root project**, printed by the `[ExpoRootProject] Using the following versions:`
  banner at the top of any Gradle run. Currently build-tools 36.0.0, compileSdk and
  targetSdk 36, NDK 27.1.12297006.
- **The Android Gradle Plugin's own built-in defaults**, used by any native module that
  does not read `rootProject.ext`. `@react-native-menu/menu` never sets
  `buildToolsVersion`, and `expo-updates` declares an `externalNativeBuild` without setting
  `ndkVersion`, so those fall back to build-tools 35.0.0 and NDK 27.0.12077973 — the
  `expoNdkVersion` in the flake.

Do not trust the fallback constants in `ExpoRootProjectPlugin.kt` — they are what the
plugin uses when no version catalog is present, not what this build resolves. When a new
dependency fails with `Failed to install the following SDK components`, add the version it
names to the `androidComposition` in `flake.nix`.

The NDK and CMake are not optional: `apps/mobile/modules/t3-terminal` compiles JNI C++
against a vendored `libghostty-vt`, producing `libt3terminal.so`.

CI provisions Node and pnpm with `voidzero-dev/setup-vp` so the repo's `packageManager` and
`engines.node` pins are honoured, and prepends that Node to `PATH` inside `nix develop` so
it wins over the shell's own `nodejs_24`. The React Native Gradle plugin shells out to
`node` to bundle JS.

## Runtime

A cold run takes roughly 40 minutes. The first universal build covering all four ABIs was
183MB; the arm64-only build is substantially smaller.

The `androidenv` SDK and NDK derivations are unfree, so Hydra never builds them and
`cache.nixos.org` has nothing to serve. `nix-community/cache-nix-action` keeps them in the
Actions cache; the first run spends several extra minutes fetching them from Google
directly, and later runs restore them from the cache instead. The two NDKs dominate the
closure at roughly 2.5GB each, which is what `gc-max-store-size-linux` is sized around.
