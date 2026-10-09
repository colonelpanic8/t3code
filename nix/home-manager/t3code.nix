{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.t3code;
  managedFiles = import ./managed-files.nix {inherit lib pkgs;};
  environment = lib.filterAttrs (_: value: value != null) {
    T3CODE_MANAGED_CLIENT_SETTINGS_FILE =
      if cfg.settings == {}
      then null
      else "${managedFiles.settingsFile "t3code-managed-client-settings.json" cfg.settings}";
    T3CODE_MANAGED_KEYBINDINGS_FILE =
      if cfg.keybindings == []
      then null
      else "${managedFiles.keybindingsFile cfg.keybindings}";
    T3CODE_MANAGED_CONNECTIONS_FILE = cfg.managedConnectionsFile;
  };
  wrapperArgs =
    lib.mapAttrsToList (name: value: "--set ${name} ${lib.escapeShellArg value}") environment
    ++ lib.optional (cfg.backendMode != null)
    "--add-flags ${lib.escapeShellArg "--backend-mode=${cfg.backendMode}"}";
  # The launcher, desktop entry, and macOS bundle all reach this wrapper, so the
  # managed files apply however the app is opened.
  package = pkgs.symlinkJoin {
    pname = "${cfg.package.pname or "t3code"}-managed";
    inherit (cfg.package) version;
    paths = [cfg.package];
    nativeBuildInputs = [pkgs.makeBinaryWrapper];
    postBuild =
      ''
        wrapProgram "$out/bin/t3code-desktop" ${lib.concatStringsSep " " wrapperArgs}
      ''
      + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        for app in "$out"/Applications/*.app; do
          name="$(basename "$app" .app)"
          rm -rf "$app"
          ${pkgs.stdenv.shell} ${lib.getExe pkgs.writeDarwinBundle} \
            "$out" "$name" t3code-desktop t3code
        done
      '';
    inherit (cfg.package) meta;
  };
in {
  options.programs.t3code = {
    enable = lib.mkEnableOption "the T3 Code desktop app with managed settings";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      defaultText = lib.literalExpression "inputs.t3code.packages.\${pkgs.system}.t3code";
      description = ''
        T3 Code package to wrap. It must not already pass `--backend-mode`;
        set {option}`programs.t3code.backendMode` instead.
      '';
    };

    backendMode = lib.mkOption {
      type = lib.types.nullOr (lib.types.enum ["managed" "client-only"]);
      default = null;
      description = ''
        Whether the desktop app starts its own local backend (`managed`) or only
        connects to existing environments (`client-only`). Null keeps the
        choice in the app's own settings.
      '';
    };

    managedConnectionsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/user/1000/t3code/managed-connections.json";
      description = ''
        Runtime path of a managed-connections.json listing environments the
        desktop app connects to without pairing. It carries bearer tokens, so
        render it outside the Nix store, for example from an agenix secret.
      '';
    };

    settings = managedFiles.settingsOption ''
      Client settings fixed by system configuration, such as fonts, diff
      layout, sidebar order, or confirmations, in the format of the desktop's
      client-settings.json. Each top-level key replaces the user's value; keys
      left out stay editable.
    '';

    keybindings = managedFiles.keybindingsOption ''
      Keybindings fixed for the backend the desktop app starts itself. Clients
      read keybindings from the environment they are anchored to, so with
      `backendMode = "client-only"` set {option}`services.t3code.keybindings`
      on that environment instead.
    '';
  };

  config = lib.mkIf cfg.enable {
    # Outranks a plain T3 Code package installed by services.t3code.
    home.packages = [(lib.hiPrio package)];
  };
}
