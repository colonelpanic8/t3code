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

      # nixpkgs already carries a working t3code derivation. Rather than
      # re-deriving the whole Electron/pnpm build here, build THIS checkout
      # through it. That keeps the flake small and keeps it working when the
      # upstream packaging changes.
      unwrapped = (pkgs.t3code.unwrapped.override {pnpm_10 = pnpm;}).overrideAttrs (
        finalAttrs: previousAttrs: {
          version = "${previousAttrs.version}-flake";
          src = self;

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
