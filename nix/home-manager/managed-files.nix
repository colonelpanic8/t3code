# Read-only files that T3 Code applies above the user's own settings. Values
# set here show as "Managed by system configuration" and cannot be changed
# from any client; unset keys stay user-editable.
{
  lib,
  pkgs,
}: let
  jsonFormat = pkgs.formats.json {};
in {
  settingsOption = description:
    lib.mkOption {
      inherit (jsonFormat) type;
      default = {};
      inherit description;
    };

  keybindingsOption = description:
    lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          key = lib.mkOption {
            type = lib.types.str;
            example = "mod+shift+j";
            description = "Shortcut in keybindings.json syntax.";
          };
          command = lib.mkOption {
            type = lib.types.str;
            example = "terminal.toggle";
            description = "Command ID, as listed in Settings → Keybindings.";
          };
          when = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = "!terminalFocus";
            description = "Optional when clause.";
          };
        };
      });
      default = [];
      inherit description;
    };

  settingsFile = name: settings: jsonFormat.generate name settings;

  keybindingsFile = bindings:
    jsonFormat.generate "t3code-managed-keybindings.json"
    (map (lib.filterAttrs (_: value: value != null)) bindings);
}
