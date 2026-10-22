# Android assembly F-Droid channel

`.github/workflows/android-stack-build.yml` publishes the Android client from
the generated `t3code/assembled` branch without EAS. It uses the Android SDK,
NDKs, CMake, Java, Node, and pnpm versions pinned by this checkout's Nix flake.

The workflow runs after each push to `t3code/assembled` and can also be started
manually. It performs the whole distribution transaction in one repository:

1. prebuild and compile the `assembly` Android variant for `arm64-v8a`;
2. replace the generated debug signature with the private F-Droid key;
3. publish the APK as an `android-assembly-*` GitHub release;
4. index recent assembly releases with `fdroidserver`; and
5. deploy the repository through GitHub Pages.

The repository URL is
<https://colonelpanic8.github.io/t3code/fdroid/repo>. The landing page includes
the signing-key fingerprint required for an authenticated first fetch.

## Identity and updates

Assembly builds use package ID `com.t3tools.t3code.assembly`, so they install
alongside official development, preview, and production variants. The app name
is `T3 Code Assembly` and the URL scheme is `t3code-assembly`.

The version code is `100000000 + GITHUB_RUN_NUMBER`; the reserved range keeps
assembly versions monotonic and separate from official releases. The version
name includes the app version, workflow run number, and assembled commit.

Expo over-the-air updates are disabled for this variant. All application
updates therefore arrive through F-Droid and correspond to a signed APK whose
release notes record the assembled commit and content tree.

## Signing material

The same private PKCS#12 key signs the APK and F-Droid index. GitHub Actions
reads it from `FDROID_KEYSTORE_BASE64`, `FDROID_KEY_ALIAS`,
`FDROID_KEYSTORE_PASSWORD`, and `FDROID_KEY_PASSWORD`; no decrypted signing
material is committed. The offline copy is stored in `pass` under
`fdroid/t3code-index-keystore`.

Losing or replacing this key breaks both APK upgrades and the repository
fingerprint. Treat it as release signing material, not as a disposable CI key.

## Architecture and toolchain

Only `arm64-v8a` is published. Standard x86_64 Android emulators need a local
build with a matching `T3CODE_APK_ABIS` value instead:

```bash
nix run .#build-android
```

The Nix Android shell declares all SDK and native components Gradle needs,
including both NDK versions used by Expo and native modules. The terminal
module also compiles JNI code against the vendored Ghostty library, so NDK and
CMake availability are required even for an APK that otherwise looks like a
JavaScript application.
