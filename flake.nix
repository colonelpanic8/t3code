{
  description = "T3 Code - development shell and desktop package built from this checkout";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }: let
    systems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  in
    flake-utils.lib.eachSystem systems (system: let
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };
      lib = pkgs.lib;

      # Vite+ bootstraps the exact version named in packageManager, so the
      # offline dependency closure must be installed by a matching pnpm.
      pnpm = pkgs.pnpm_11;
      nodejs = pkgs.nodejs_22;

      # The app shows which commit it was built from, but `src = self` carries
      # no .git and the sandbox has no network, so nothing in the build can
      # work that out on its own -- it has to be handed down from evaluation.
      # `rev` is absent for a dirty or path-based source; the app renders an
      # empty value as "no provenance" rather than inventing one.
      # `dirtyRev` appends "-dirty", which would make the commit unlinkable.
      # Strip it: T3CODE_BUILD_DIRTY already carries that, and the base commit
      # is still the useful thing to point at.
      buildCommit =
        if self ? rev
        then self.rev
        else if self ? dirtyRev
        then pkgs.lib.removeSuffix "-dirty" self.dirtyRev
        else "";
      lastModifiedDate = self.lastModifiedDate or "";
      # lastModifiedDate is a UTC "YYYYMMDDHHMMSS" stamp. The app wants ISO 8601.
      buildDate =
        if lastModifiedDate == ""
        then ""
        else let
          part = start: length: builtins.substring start length lastModifiedDate;
        in "${part 0 4}-${part 4 2}-${part 6 2}T${part 8 2}:${part 10 2}:${part 12 2}Z";

      # nixpkgs already carries a working t3code derivation. Rather than
      # re-deriving the whole Electron/pnpm build here, build THIS checkout
      # through it. That keeps the flake small and keeps it working when the
      # upstream packaging changes.
      unwrapped = (pkgs.t3code.unwrapped.override {pnpm_10 = pnpm;}).overrideAttrs (
        finalAttrs: previousAttrs: {
          version =
            "${previousAttrs.version}-source"
            + pkgs.lib.optionalString (buildCommit != "") "-${builtins.substring 0 8 buildCommit}";
          src = self;

          # Read by apps/web/vite.config.ts. The repository remote is left
          # unset on purpose: an assembled build already names its fork in
          # stack-build-info.json, and a plain flake build of an arbitrary
          # checkout has no business claiming one.
          #
          # These MUST go in `env`, not at the top level. This derivation sets
          # __structuredAttrs, under which top-level attributes become ordinary
          # (unexported) shell variables in .attrs.sh -- so `vp build` would run
          # as a child process that never sees them, and the app would ship with
          # a blank commit while the build stayed green. Only `env` members
          # become real environment variables.
          env =
            (previousAttrs.env or {})
            // {
              T3CODE_BUILD_COMMIT = buildCommit;
              T3CODE_BUILD_DATE = buildDate;
              T3CODE_BUILD_DIRTY =
                if self ? dirtyRev
                then "1"
                else "0";
            };

          # NOT `(previousAttrs.postPatch or "") + ...`. nixpkgs' postPatch
          # rewrites the dev-server host default with --replace-fail against a
          # one-line form that upstream has since split in two:
          #
          #   const host = process.env.HOST?.trim() || "localhost";
          # became
          #   const explicitHost = process.env.HOST?.trim();
          #   const host = explicitHost || "localhost";
          #
          # Inheriting it fails the build outright whenever this stack is ahead
          # of the pinned nixpkgs release. Restate the intent -- bind the dev
          # server to 127.0.0.1 rather than the "localhost" alias -- against the
          # shape this tree actually has, and tolerate either form so the build
          # survives the next upstream edit to those lines.
          postPatch = ''
            substituteInPlace apps/web/vite.config.ts \
              --replace-quiet 'const host = process.env.HOST?.trim() || "localhost";' \
                              'const host = process.env.HOST?.trim() || "127.0.0.1";' \
              --replace-quiet 'const host = explicitHost || "localhost";' \
                              'const host = explicitHost || "127.0.0.1";'

            grep -q 'const host = .*"127\.0\.0\.1";' apps/web/vite.config.ts || {
              echo "vite.config.ts: dev host default did not match either known form" >&2
              exit 1
            }

            substituteInPlace package.json \
              --replace-warn '"packageManager": "pnpm@11.10.0"' \
                             '"packageManager": "pnpm@${pnpm.version}"'
          '';

          # The Vite+ task runner walks every declared workspace and tries to
          # install the mobile and infra workspaces, which are intentionally not
          # fetched. Run the desktop dependency chain directly instead:
          # web -> server -> Electron shell.
          buildPhase = ''
            runHook preBuild

            pushd apps/web
            ../../node_modules/.bin/vp build
            popd

            node apps/server/scripts/cli.ts build --verbose
            node apps/desktop/scripts/build-preview-annotation-css.mjs

            pushd apps/desktop
            ../../node_modules/.bin/vp pack
            popd

            runHook postBuild
          '';

          # `pnpm vp cache clean` also triggers the workspace bootstrap, and the
          # build above does not enable Vite+ task caching.
          postBuild = "";

          postInstall =
            (previousAttrs.postInstall or "")
            + ''
              # In nixpkgs' unpacked Electron layout, app.getAppPath() resolves
              # to apps/desktop rather than the archive root. Mirror the packaged
              # app's relative renderer path so client-only mode finds the
              # renderer bundle.
              mkdir -p "$out/libexec/t3code/apps/desktop/apps/server/dist"
              ln -s ../../../../server/dist/client \
                "$out/libexec/t3code/apps/desktop/apps/server/dist/client"
            '';

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pnpm;
            inherit
              (finalAttrs)
              pname
              version
              src
              pnpmWorkspaces
              ;
            fetcherVersion = 4;
            # Fixed-output hash over the offline dependency closure. It is
            # derived from pnpm-lock.yaml, so refresh it whenever the lockfile
            # changes: set lib.fakeHash, build, and copy the reported `got:`.
            hash = "sha256-QNVBRvXVUOKZEdIqKY2dfjvmivMTaJJSh2cexvtdJ6k=";
          };
        }
      );
      t3code = pkgs.t3code.override {t3code-unwrapped = unwrapped;};
      client = t3code.overrideAttrs (previousAttrs: {
        pname = "t3code-client";
        buildCommand =
          previousAttrs.buildCommand
          + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            # Chromium does not recognize every Linux desktop as having a
            # native password store. Prefer Secret Service explicitly so
            # Electron safeStorage does not silently fall back to basic_text.
            mv "$out/bin/t3code-desktop" \
              "$out/bin/.t3code-desktop-client-unwrapped"
            makeWrapper "$out/bin/.t3code-desktop-client-unwrapped" \
              "$out/bin/t3code-desktop" \
              --add-flags "--password-store=gnome-libsecret" \
              --add-flags "--backend-mode=client-only"
          ''
          + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
            # makeWrapper is makeBinaryWrapper here, so the app bundle still
            # launches a native Mach-O executable rather than a shell script.
            mv "$out/bin/t3code-desktop" \
              "$out/bin/.t3code-desktop-client-unwrapped"
            makeWrapper "$out/bin/.t3code-desktop-client-unwrapped" \
              "$out/bin/t3code-desktop" \
              --add-flags "--backend-mode=client-only"
          '';
      });

      androidBuildToolsVersion = "36.0.0";
      androidCommandLineToolsVersion = "8.0";
      androidNdkVersion = "27.1.12297006";
      expoNdkVersion = "27.0.12077973";
      androidComposition = pkgs.androidenv.composeAndroidPackages {
        cmdLineToolsVersion = androidCommandLineToolsVersion;
        toolsVersion = "26.1.1";
        platformToolsVersion = "35.0.2";
        buildToolsVersions = [androidBuildToolsVersion "35.0.0" "34.0.0"];
        platformVersions = ["35" "36"];
        includeSources = false;
        abiVersions = ["x86_64"];
        includeNDK = true;
        ndkVersions = [androidNdkVersion expoNdkVersion];
        cmakeVersions = ["3.22.1"];
        useGoogleAPIs = true;
        useGoogleTVAddOns = false;
      };
      androidSdk = androidComposition.androidsdk;
      androidHome = "${androidSdk}/libexec/android-sdk";
      androidJdk = pkgs.jdk17;
      androidShell = pkgs.mkShell {
        packages = with pkgs; [
          androidJdk
          androidSdk
          curl
          git
          gnumake
          nodejs_24
          pkg-config
          python3
          watchman
          xz
          zig_0_15
        ];

        ANDROID_HOME = androidHome;
        ANDROID_SDK_ROOT = androidHome;
        ANDROID_NDK_HOME = "${androidHome}/ndk/${androidNdkVersion}";
        ANDROID_NDK_ROOT = "${androidHome}/ndk/${androidNdkVersion}";
        GHOSTTY_ZIG = "${pkgs.zig_0_15}/bin/zig";
        JAVA_HOME = androidJdk.home;
        LC_ALL = "en_US.UTF-8";
        LANG = "en_US.UTF-8";
        GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidHome}/build-tools/${androidBuildToolsVersion}/aapt2";
        NODE_OPTIONS = "--max-old-space-size=8192";

        shellHook = ''
          export PATH="${androidHome}/platform-tools:${androidHome}/cmdline-tools/${androidCommandLineToolsVersion}/bin:$PWD/node_modules/.bin:$PWD/apps/mobile/node_modules/.bin:$PATH"
          echo "T3 Code Android dev shell"
          echo "  node: $(node --version)"
          echo "  pnpm: $(corepack pnpm --version)"
          echo "  java: $(java -version 2>&1 | head -n 1)"
          echo "  sdk:  $ANDROID_SDK_ROOT"
          echo "  ndk:  $ANDROID_NDK_HOME"
        '';
      };
      androidBuilder = pkgs.writeShellApplication {
        name = "build-t3code-android";
        runtimeInputs = with pkgs; [
          coreutils
          gawk
          gnused
          nix
        ];
        text =
          ''
            export T3CODE_SOURCE_TREE=${lib.escapeShellArg "${self}"}
            export T3CODE_ANDROID_FLAKE=${lib.escapeShellArg "${self}"}
            export T3CODE_SOURCE_REV=${lib.escapeShellArg (
              if buildCommit == ""
              then "local"
              else builtins.substring 0 8 buildCommit
            )}
          ''
          + builtins.readFile ./nix/scripts/build-android-apk.sh;
      };
    in {
      packages = {
        inherit client t3code unwrapped;
        default = t3code;
      };

      apps = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        build-android = {
          type = "app";
          program = lib.getExe androidBuilder;
          meta.description = "Build a sideloadable Android APK from this checkout";
        };
      };

      # Launch the packaged app headlessly and fail on a renderer crash.
      #
      # A dropped import is a runtime ReferenceError, not a bundler error, so a
      # green `nix build` says nothing about whether the app boots. That has
      # shipped a build whose first paint was "Something went wrong:
      # useEnvironmentSettings is not defined". This check catches that class.
      checks = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        smoke =
          pkgs.runCommand "t3code-smoke" {
            nativeBuildInputs = [pkgs.xvfb-run pkgs.dbus];
          } ''
            export HOME=$(mktemp -d)
            export XDG_RUNTIME_DIR=$(mktemp -d)
            set +e
            timeout 20 xvfb-run -a ${pkgs.dbus}/bin/dbus-run-session \
              --config-file=${pkgs.dbus}/share/dbus-1/session.conf -- \
              ${t3code}/bin/t3code-desktop \
                --backend-mode=client-only --no-sandbox \
              > "$HOME/out.log" 2>&1
            app_status=$?
            set -e

            echo "--- app output ---"; cat "$HOME/out.log" || true

            # A healthy Electron main process stays up until the timeout. An
            # early exit means the launcher failed before the renderer could be
            # checked (for example, a broken D-Bus session).
            if [ "$app_status" -ne 124 ]; then
              echo "SMOKE FAILED: app exited before the timeout (status $app_status)" >&2
              exit 1
            fi

            # Electron logs renderer exceptions to stderr; any of these means the
            # UI failed to mount even if the process exited 0.
            if grep -qE "is not defined|ReferenceError|Something went wrong" "$HOME/out.log"; then
              echo "SMOKE FAILED: renderer crashed on boot" >&2
              exit 1
            fi
            touch $out
          '';
      };

      devShells =
        {
          default = pkgs.mkShell {
            packages = [nodejs pnpm pkgs.git];

            # Electron's postinstall download is useless in a sandbox; point
            # the tooling at the nixpkgs build instead.
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/libexec/electron";

            shellHook = ''
              echo "T3 Code dev shell: node $(node --version), pnpm $(pnpm --version)"
            '';
          };
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          android = androidShell;
        };

      formatter = pkgs.alejandra;
    })
    // {
      overlays = {
        # Build this checkout in place of nixpkgs's released source.
        default = final: _previous: {
          t3code = self.packages.${final.stdenv.hostPlatform.system}.t3code;
        };

        # Desktop-client installations can opt into the persistent-backend
        # wrapper without imposing that policy on every flake consumer.
        client = final: _previous: {
          t3code = self.packages.${final.stdenv.hostPlatform.system}.client;
        };
      };

      homeManagerModules = {
        default = self.homeManagerModules.t3code-server;
        t3code-server = import ./nix/home-manager/t3code-server.nix {inherit self;};
      };
    };
}
