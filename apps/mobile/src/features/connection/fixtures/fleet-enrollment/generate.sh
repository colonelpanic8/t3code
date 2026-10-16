#!/usr/bin/env bash
# Regenerates the fleet enrollment test fixtures with stock age and fresh
# TEST-ONLY keys. Nothing here is a real identity or credential.
#   nix shell nixpkgs#age nixpkgs#openssh --command ./generate.sh
# Plain .txt names keep the formatter and the *.key ignore off these files.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

rm -f "$out"/phone-identity.txt
age-keygen -o "$out/phone-identity.txt" 2>/dev/null
age-keygen -y "$out/phone-identity.txt" >"$out/phone.pub"
age-keygen -o "$scratch/other.key" 2>/dev/null
ssh-keygen -q -t ed25519 -N "" -C "fixture-ed25519" -f "$scratch/ed25519"
ssh-keygen -q -t rsa -b 2048 -N "" -C "fixture-rsa" -f "$scratch/rsa"

{
  cat "$scratch/ed25519.pub" "$scratch/rsa.pub"
  age-keygen -y "$scratch/other.key"
  cat "$out/phone.pub"
} >"$scratch/mixed.txt"

credential="t3enroll1.$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
cat >"$out/enrollment-plaintext.txt" <<EOF
{"version":1,"type":"t3code.fleet-enrollment","anchor":{"environmentId":"fixture-anchor","label":"Fixture anchor","httpBaseUrl":"http://anchor.fixture.test:3773","wsBaseUrl":"ws://anchor.fixture.test:3773"},"credential":"$credential","expiresAt":"2099-01-01T00:00:00.000Z"}
EOF

age -e -a -R "$scratch/mixed.txt" -o "$out/mixed.age" "$out/enrollment-plaintext.txt"
age -e -R "$scratch/mixed.txt" -o "$out/mixed.bin" "$out/enrollment-plaintext.txt"
age -e -a -r "$(age-keygen -y "$scratch/other.key")" -o "$out/other-only.age" "$out/enrollment-plaintext.txt"

head -c 6000 /dev/zero | tr '\0' 'x' >"$scratch/oversize.txt"
age -e -R "$scratch/mixed.txt" -o "$out/oversize.bin" "$scratch/oversize.txt"
