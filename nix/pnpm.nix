{pkgs}: let
  version = "12.14.0";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha512-F6K8e/jWxiuEYJaQtRRUG9ynBSTEHa+t7Lf86MKuOO5UA7WVVMbi+oB8nY6iKW++ncWS2yG6T9faXZGxqNsfoQ==";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha512-7joGShZ44Nk3WpNU+60JoOPjCXlgxhJAq11S2UiVtwCUDgTer1yTPPfxGW8pxaD6046actYLIYDbZNlubHWs0A==";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha512-tnrdUB8ecJoehuKKqi1YHCBVl61xtJ9XVGcx5EviC6fWO4DeGI8GtXrjvJxDBM3nuVjJeWistgsUp/N142x4sw==";
    };
  };
  source = sources.${pkgs.stdenv.hostPlatform.system};
in
  pkgs.stdenv.mkDerivation {
    pname = "pnpm";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@pnpm/exe.${source.platform}/-/exe.${source.platform}-${version}.tgz";
      inherit (source) hash;
    };
    nativeBuildInputs =
      [pkgs.makeWrapper]
      ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [pkgs.autoPatchelfHook];
    buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [pkgs.stdenv.cc.cc.lib];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 pnpm "$out/bin/pnpm"
      makeWrapper "$out/bin/pnpm" "$out/bin/pnpx" --add-flags dlx
      ln -s pnpm "$out/bin/pn"
      ln -s pnpx "$out/bin/pnx"
      runHook postInstall
    '';
    passthru = {
      majorVersion = "12";
      nodejs-slim = pkgs.nodejs_26;
    };
    meta = {
      description = "Fast, disk space efficient package manager for JavaScript";
      homepage = "https://pnpm.io/";
      license = pkgs.lib.licenses.mit;
      mainProgram = "pnpm";
      platforms = builtins.attrNames sources;
    };
  }
