{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.t3code;
  managedFiles = import ./managed-files.nix {inherit lib pkgs;};
  # The server refuses to start on a server.json it cannot decode, so every
  # key it knows is typed to match apps/server/src/cli/serverConfigFile.ts.
  serverConfigType = let
    inherit (lib) types;
    optional = type: description:
      lib.mkOption {
        type = types.nullOr type;
        default = null;
        inherit description;
      };
    nonBlankStr =
      types.addCheck types.str (value: lib.trim value != "")
      // {description = "non-blank string";};
    serverPort = types.ints.between 1 65535;
    logLevel = types.enum ["All" "Fatal" "Error" "Warn" "Info" "Debug" "Trace" "None"];
  in
    types.submodule {
      freeformType = (pkgs.formats.json {}).type;
      options = {
        port = optional serverPort "Port the server listens on.";
        host = optional nonBlankStr "Address the server listens on.";
        mode = optional (types.enum ["web" "desktop"]) "Runtime mode.";
        noBrowser = optional types.bool "Whether to skip opening a browser.";
        tailscaleServeEnabled = optional types.bool "Whether to publish the server with Tailscale Serve.";
        tailscaleServePort = optional serverPort "Tailnet-only HTTPS port exposed by Tailscale Serve.";
        logLevel = optional logLevel "Minimum log level.";
        logWebSocketEvents = optional types.bool "Whether to log WebSocket events.";
        traceFile = optional nonBlankStr "Trace file path. Use an absolute path.";
        traceMinLevel = optional logLevel "Minimum level written to the trace file.";
        traceTimingEnabled = optional types.bool "Whether to record span timings.";
        traceBatchWindowMs = optional types.ints.unsigned "Trace batch window in milliseconds.";
        traceMaxBytes = optional types.ints.unsigned "Maximum size of one trace file in bytes.";
        traceMaxFiles = optional types.ints.unsigned "Number of rotated trace files kept.";
        otlpTracesUrl = optional nonBlankStr "OTLP traces endpoint.";
        otlpMetricsUrl = optional nonBlankStr "OTLP metrics endpoint.";
        otlpLogsUrl = optional nonBlankStr "OTLP logs endpoint.";
        otlpProtocol = optional (types.enum ["http/json" "http/protobuf"]) "OTLP export protocol.";
        otlpHeaders = optional (types.attrsOf types.str) "Headers sent with OTLP exports.";
        otlpExportIntervalMs = optional types.ints.unsigned "OTLP export interval in milliseconds.";
      };
    };
  serverConfig = lib.filterAttrs (_: value: value != null) cfg.serverConfig;
  # Keys the launch script always passes as flags, which outrank server.json.
  overriddenServerConfigKeys =
    ["host" "port"]
    ++ lib.optionals cfg.tailscaleServe.enable ["tailscaleServeEnabled" "tailscaleServePort"];
  # Set on the service rather than in the launch script so a replaced
  # ExecStart or ProgramArguments still sees these files.
  serviceEnvironment =
    lib.optionalAttrs (cfg.settings != {}) {
      T3CODE_MANAGED_SETTINGS_FILE = "${managedFiles.settingsFile "t3code-managed-settings.json" cfg.settings}";
    }
    // lib.optionalAttrs (cfg.keybindings != []) {
      T3CODE_MANAGED_KEYBINDINGS_FILE = "${managedFiles.keybindingsFile cfg.keybindings}";
    }
    // lib.optionalAttrs (cfg.sharedSettings != {}) {
      T3CODE_SERVER_SHARED_SETTINGS_FILE = "${managedFiles.settingsFile "t3code-shared-settings.json" cfg.sharedSettings}";
    }
    // lib.optionalAttrs (serverConfig != {}) {
      T3CODE_SERVER_CONFIG_FILE = "${managedFiles.settingsFile "t3code-server.json" serverConfig}";
    };
  serverCommand = pkgs.writeShellScript "t3code-headless-server" ''
    set -eu

    repository_root=${lib.escapeShellArg cfg.repositoryRoot}
    if [ ! -d "$repository_root" ]; then
      echo "T3 Code repository root does not exist: $repository_root" >&2
      exit 69
    fi

    export PATH=${lib.escapeShellArg "${lib.makeBinPath ([cfg.package] ++ cfg.extraPackages)}:/run/current-system/sw/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
    export T3CODE_HOME=${lib.escapeShellArg cfg.dataDirectory}
    ${lib.optionalString (cfg.fleetManifest != null) ''
      export T3CODE_FLEET_MANIFEST_FILE=${pkgs.writeText "t3code-fleet.json" (builtins.toJSON {
        version = 1;
        environments = cfg.fleetManifest;
      })}
    ''}

    cd "$repository_root"
    server_args=(
      serve
      --host ${lib.escapeShellArg cfg.host}
      --port ${toString cfg.port}
      ${lib.optionalString cfg.tailscaleServe.enable ''
      --tailscale-serve
      --tailscale-serve-port ${toString cfg.tailscaleServe.port}
    ''}
    )
    exec ${lib.getExe' cfg.package "t3"} "''${server_args[@]}"
  '';
in {
  options.services.t3code = {
    enable = lib.mkEnableOption "a persistent T3 Code headless server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      defaultText = lib.literalExpression "inputs.t3code.packages.\${pkgs.system}.t3code";
      description = "T3 Code package used by the service.";
    };

    repositoryRoot = lib.mkOption {
      type = lib.types.str;
      default = config.home.homeDirectory;
      description = "Repository opened by the persistent T3 Code server.";
    };

    dataDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.t3";
      description = "Persistent T3 Code state directory.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which the local T3 Code server listens.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3774;
      description = "Port on which the local T3 Code server listens.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        bashInteractive
        claude-code
        codex
        coreutils
        findutils
        gh
        git
        gnugrep
        gnused
        nix
        nodejs
        openssh
        ripgrep
        tailscale
        zsh
      ];
      description = "Additional packages available to the server and its provider processes.";
    };

    settings = managedFiles.settingsOption ''
      Server settings fixed by system configuration, in the format of the
      server's settings.json. Each entry of `providerInstances`,
      `usageLimitSources`, and `usagePriceOverrides` is managed whole: it must
      be complete (a provider instance needs its `driver`, a usage limit
      source its `kind`) and replaces the local entry with the same key. Other
      objects merge key by key, anything else replaces the user's value, and
      keys left out stay editable. The server ignores an invalid managed entry
      with a warning. The file lands in the Nix store, so reference credentials
      such as GitHub tokens as `{ "$file" = "/run/agenix/github-token"; }`.
      A credential written inline makes the server ignore the whole file, and
      `$file` works only where a credential goes: an environment variable's
      value, a provider's secret config fields, source control host tokens,
      and a usage limit source's `managementKey`.
    '';

    sharedSettings = managedFiles.settingsOption ''
      Default server settings, in the format of the server's settings.json.
      Unlike `settings`, nothing here is locked: the server reads this file
      beneath settings.json, so a change made from any client is saved to that
      machine's settings.json and overrides the value here for that machine
      only. Settings left untouched keep following this file.

      One invalid value makes the server ignore the whole file, with a
      warning. `$file` references are not resolved here, and the file lands
      in the Nix store, which is world-readable, so put credential-bearing
      keys in `settings` instead. The file is set only in the service's
      environment: `t3` commands run from a shell while the service is
      stopped do not see it. Requires a package with shared settings file
      support; older packages ignore it.
    '';

    serverConfig = lib.mkOption {
      type = serverConfigType;
      default = {};
      description = ''
        Server startup options, in the format of the server's server.json (for
        example `logLevel`, `traceFile`, or `otlpTracesUrl`). The server reads
        it once at startup, in place of `<configDir>/server.json`: the two are
        not merged. Requires a package with server.json support; older
        packages ignore it. Keys the server knows are type-checked here
        because it refuses to start on an invalid value; unknown keys pass
        through and only draw a warning from the server.

        The `host` and `port` options are always passed as flags, so they win
        over the same keys here; `tailscaleServe` likewise wins over
        `tailscaleServeEnabled` and `tailscaleServePort` while it is enabled.
        Relative paths resolve against the file's directory in the Nix store,
        so use absolute paths. The Nix store is world-readable: do not put
        credentials such as `otlpHeaders` tokens here.
      '';
    };

    keybindings = managedFiles.keybindingsOption ''
      Keybindings fixed by system configuration. Each rule replaces the user's
      rules for the same command or the same shortcut, and clients cannot
      change or remove it.
    '';

    fleetManifest = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf (lib.types.submodule {
        options = {
          environmentId = lib.mkOption {
            type = lib.types.str;
            description = "Environment id the member server reports.";
          };
          label = lib.mkOption {
            type = lib.types.str;
            description = "Display name clients show for the member.";
          };
          httpBaseUrl = lib.mkOption {
            type = lib.types.str;
            description = "HTTP(S) origin clients reach the member at.";
          };
          wsBaseUrl = lib.mkOption {
            type = lib.types.str;
            description = "WebSocket origin clients reach the member at.";
          };
        };
      }));
      default = null;
      description = ''
        The fleet this server belongs to, itself included. Members sharing a
        managed access token hand clients paired with one of them a single-use
        credential for each of the others. The manifest holds no secrets.
      '';
    };

    systemdTarget = lib.mkOption {
      type = lib.types.str;
      default = "graphical-session.target";
      description = "User systemd target that starts the service.";
    };

    tailscaleServe = {
      enable = lib.mkEnableOption "Tailscale Serve publication" // {default = true;};

      port = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "Tailnet-only HTTPS port exposed by Tailscale Serve.";
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [cfg.package];

      warnings =
        map (key: "services.t3code.serverConfig.${key} has no effect: the service always passes it as a flag.")
        (builtins.filter (key: serverConfig ? ${key}) overriddenServerConfigKeys)
        ++ lib.optional (!cfg.tailscaleServe.enable && serverConfig.tailscaleServeEnabled or false)
        "services.t3code.serverConfig.tailscaleServeEnabled = true publishes the server with Tailscale Serve even though services.t3code.tailscaleServe.enable is false.";
    }

    (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
      systemd.user.services.t3code-headless = {
        Unit = {
          Description = "T3 Code headless server";
          Documentation = "https://github.com/pingdotgg/t3code/blob/main/REMOTE.md";
          After = [cfg.systemdTarget];
          ConditionPathIsDirectory = cfg.repositoryRoot;
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };

        Service = {
          Type = "simple";
          ExecStart = "${serverCommand}";
          Restart = "always";
          RestartSec = 5;
          TimeoutStopSec = 15;
          UMask = "0077";
          Environment = lib.mkIf (serviceEnvironment != {}) (
            lib.mapAttrsToList (name: value: "${name}=${value}") serviceEnvironment
          );
        };

        # Deliberately omit PartOf so the backend survives graphical logout.
        Install.WantedBy = [cfg.systemdTarget];
      };
    })

    (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      launchd.agents.t3code-headless = {
        enable = true;
        config = {
          ProgramArguments = ["${serverCommand}"];
          KeepAlive = true;
          ProcessType = "Interactive";
          RunAtLoad = true;
          ThrottleInterval = 5;
          EnvironmentVariables = lib.mkIf (serviceEnvironment != {}) serviceEnvironment;
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/t3code-headless.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/t3code-headless.err.log";
        };
      };
    })
  ]);
}
