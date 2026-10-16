{
  pkgs,
  environments,
}: let
  inherit (pkgs) lib;
  fields = ["environmentId" "httpBaseUrl" "label" "wsBaseUrl"];
  nonBlank = value: builtins.isString value && lib.trim value != "";
  parseUrl = value:
    builtins.match "(https?|wss?)://([^/?#@[:space:][:cntrl:]]+)(/[^?#@[:space:][:cntrl:]]*)?" value;
  validAuthority = authority: let
    parts = builtins.match "([[][0-9a-fA-F:]+[]]|[a-zA-Z0-9._-]+)(:([0-9]{1,5}))?" authority;
    port = builtins.elemAt parts 2;
  in
    parts != null && (port == null || lib.strings.toIntBase10 port <= 65535);
  validMember = member:
    builtins.isAttrs member
    && builtins.attrNames member == fields
    && builtins.all (field: nonBlank member.${field}) fields
    && !(lib.hasInfix "\\" member.httpBaseUrl || lib.hasInfix "\\" member.wsBaseUrl)
    && (let
      http = parseUrl member.httpBaseUrl;
      ws = parseUrl member.wsBaseUrl;
    in
      http
      != null
      && ws != null
      && validAuthority (builtins.elemAt http 1)
      && validAuthority (builtins.elemAt ws 1)
      && builtins.elemAt http 1 == builtins.elemAt ws 1
      && (
        (builtins.elemAt http 0 == "https" && builtins.elemAt ws 0 == "wss")
        || (builtins.elemAt http 0 == "http" && builtins.elemAt ws 0 == "ws")
      ));
  ids = map (member: member.environmentId) environments;
  json = builtins.toJSON {
    version = 1;
    inherit environments;
  };
in
  assert lib.assertMsg
  (builtins.isList environments && environments != [] && builtins.length environments <= 100)
  "A T3 Code fleet import must contain between 1 and 100 environments.";
  assert lib.assertMsg (builtins.all validMember environments)
  "A T3 Code fleet import accepts only IDs, labels, and matching HTTP/WebSocket addresses without credentials, queries, or fragments.";
  assert lib.assertMsg (builtins.length ids == builtins.length (lib.unique ids))
  "A T3 Code fleet import must have unique environment IDs.";
  assert lib.assertMsg (builtins.stringLength json <= 65536)
  "A T3 Code fleet import must be at most 64 KiB.";
    pkgs.writeText "t3code-fleet.json" json
