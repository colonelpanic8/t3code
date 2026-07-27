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
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

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
          version = "${previousAttrs.version}-flake";
          src = self;

          # Read by apps/web/vite.config.ts. The repository remote is left
          # unset on purpose: an assembled build already names its fork in
          # stack-build-info.json, and a plain flake build of an arbitrary
          # checkout has no business claiming one.
          T3CODE_BUILD_COMMIT = buildCommit;
          T3CODE_BUILD_DATE = buildDate;
          T3CODE_BUILD_DIRTY =
            if self ? dirtyRev
            then "1"
            else "0";

          postPatch =
            (previousAttrs.postPatch or "")
            + ''
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
    in {
      packages = {
        inherit unwrapped;
        t3code = pkgs.t3code.override {t3code-unwrapped = unwrapped;};
        default = pkgs.t3code.override {t3code-unwrapped = unwrapped;};
      };

      # Launch the packaged app headlessly and fail on a renderer crash.
      #
      # A dropped import is a runtime ReferenceError, not a bundler error, so a
      # green `nix build` says nothing about whether the app boots. That has
      # shipped a build whose first paint was "Something went wrong:
      # useEnvironmentSettings is not defined". This check catches that class.
      checks.smoke =
        pkgs.runCommand "t3code-smoke" {
          nativeBuildInputs = [pkgs.xvfb-run pkgs.dbus];
        } ''
          export HOME=$(mktemp -d)
          export XDG_RUNTIME_DIR=$(mktemp -d)
          set +e
          timeout 20 xvfb-run -a ${pkgs.dbus}/bin/dbus-run-session \
            --config-file=${pkgs.dbus}/share/dbus-1/session.conf -- \
            ${self.packages.${system}.t3code}/bin/t3code-desktop \
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

      devShells.default = pkgs.mkShell {
        packages = [nodejs pnpm pkgs.git];

        # Electron's postinstall download is useless in a sandbox; point the
        # tooling at the nixpkgs build instead.
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/libexec/electron";

        shellHook = ''
          echo "T3 Code dev shell: node $(node --version), pnpm $(pnpm --version)"
        '';
      };

      formatter = pkgs.alejandra;
    });
}
