{pkgs}: let
  makeManifest = environments: import ../fleet-import.nix {inherit pkgs environments;};
  fixture = ../../packages/client-runtime/src/connection/fixtures/fleet-manifest.v1.json;
  document = builtins.fromJSON (builtins.readFile fixture);
  member = builtins.head document.environments;
  rejected = environments: !(builtins.tryEval (builtins.deepSeq (makeManifest environments) true)).success;
in
  assert rejected [];
  assert rejected [member member];
  assert rejected [(member // {token = "fixture-secret";})];
  assert rejected [(member // {httpBaseUrl = "https://user:password@alpha.example.test/";})];
  assert rejected [(member // {httpBaseUrl = "https://alpha.example.test/?token=fixture";})];
  assert rejected [(member // {httpBaseUrl = "https://alpha.example.test/#token=fixture";})];
  assert rejected [(member // {wsBaseUrl = "wss://elsewhere.example.test/";})];
  assert builtins.all (url:
    rejected [
      (member
        // {
          httpBaseUrl = url;
          wsBaseUrl = pkgs.lib.replaceStrings ["https:"] ["wss:"] url;
        })
    ]) [
    "https://alpha.example.test/path@secret"
    "https://alpha.example.test:65536/"
    "https://alpha.example.test:abc/"
    "https://alpha.example.test:123456/"
  ];
    pkgs.runCommand "t3code-fleet-import-check" {nativeBuildInputs = [pkgs.jq];} ''
      jq --sort-keys --compact-output . ${makeManifest document.environments} > actual.json
      jq --sort-keys --compact-output . ${fixture} > expected.json
      cmp actual.json expected.json
      touch "$out"
    ''
