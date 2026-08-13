#!/usr/bin/env bash
#
# Assemble the self-hosted F-Droid repository of assembly builds.
#
# Collects the APKs attached to recent android-assembly-* GitHub releases, lays out
# the fdroidserver directory structure from fdroid/config.yml, fdroid/metadata,
# and the shared fastlane metadata, then runs `fdroid update` to produce a signed
# index. The resulting directory is what gets deployed to GitHub Pages.
#
# The APKs are indexed as published rather than rebuilt, so an install from this
# repo and an install from the releases page share a signature and upgrade in
# place from each other.
#
# Environment:
#   FDROID_OUT_DIR         Output directory (default: target/fdroid)
#   FDROID_RELEASE_COUNT   How many recent releases to index (default: 5). Every
#                          indexed APK is re-uploaded on each deploy, so this
#                          trades version history against the Pages 1GB limit.
#   FDROID_KEYSTORE_BASE64 Base64 PKCS#12 keystore used to sign the index
#   FDROID_KEYSTORE_FILE   Path to that keystore, as an alternative to the above
#   FDROID_KEY_ALIAS
#   FDROID_KEYSTORE_PASSWORD
#   FDROID_KEY_PASSWORD
#   GH_TOKEN               Token for `gh release` access

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

out_dir="${FDROID_OUT_DIR:-target/fdroid}"
release_count="${FDROID_RELEASE_COUNT:-5}"

# Only the assembly variant is published through this channel.
app_id="com.t3tools.t3code.assembly"
tag_prefix="android-assembly-"
fastlane_root="fastlane/metadata/android"
icon_source="assets/nightly/nightly-ios-1024.png"

if [[ -z "${FDROID_KEYSTORE_BASE64:-}" && -z "${FDROID_KEYSTORE_FILE:-}" ]]; then
  echo "A signing keystore is required: set FDROID_KEYSTORE_BASE64 or FDROID_KEYSTORE_FILE" >&2
  exit 1
fi

for var in FDROID_KEY_ALIAS FDROID_KEYSTORE_PASSWORD FDROID_KEY_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "Signing the repo index requires $var" >&2
    exit 1
  fi
done
export FDROID_KEY_ALIAS FDROID_KEYSTORE_PASSWORD FDROID_KEY_PASSWORD

for tool in fdroid gh; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool not found on PATH: $tool" >&2
    exit 1
  fi
done

# fdroidserver signs the v2 index with apksigner, which it finds through
# ANDROID_HOME. Failing here beats failing after every APK has been downloaded.
if ! command -v apksigner >/dev/null 2>&1; then
  shopt -s nullglob
  sdk_apksigners=("${ANDROID_HOME:-/nonexistent}"/build-tools/*/apksigner)
  shopt -u nullglob

  if [[ "${#sdk_apksigners[@]}" -eq 0 ]]; then
    echo "apksigner not found: put it on PATH or set ANDROID_HOME to an SDK with build-tools" >&2
    exit 1
  fi
fi

echo "==> Preparing $out_dir"
rm -rf "$out_dir"
mkdir -p "$out_dir/repo" "$out_dir/metadata"

cp fdroid/config.yml "$out_dir/config.yml"
cp fdroid/metadata/*.yml "$out_dir/metadata/"

# fdroidserver reads localized listings from metadata/<appid>/<locale>/, the same
# layout fastlane uses, so one source keeps every store listing identical.
for locale_dir in "$fastlane_root"/*/; do
  [[ -d "$locale_dir" ]] || continue
  locale="$(basename "$locale_dir")"
  mkdir -p "$out_dir/metadata/$app_id"
  cp -r "$locale_dir" "$out_dir/metadata/$app_id/$locale"
done

# repo_icon resolves relative to the fdroid root. fdroid update copies it into
# repo/icons/ itself and wipes anything already placed there.
if [[ -f "$icon_source" ]]; then
  cp "$icon_source" "$out_dir/icon.png"
fi

echo "==> Collecting APKs from the $release_count most recent $tag_prefix releases"
mapfile -t tags < <(
  gh release list --limit 100 --json tagName,isDraft \
    --jq ".[] | select(.isDraft == false) | select(.tagName | startswith(\"$tag_prefix\")) | .tagName" \
    | head -n "$release_count"
)

if [[ "${#tags[@]}" -eq 0 ]]; then
  echo "No published $tag_prefix releases were found" >&2
  exit 1
fi

download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT

apk_count=0
for tag in "${tags[@]}"; do
  tag_dir="$download_dir/$tag"
  mkdir -p "$tag_dir"

  if ! gh release download "$tag" --pattern '*.apk' --dir "$tag_dir" 2>/dev/null; then
    echo "  $tag: no APK asset, skipping"
    continue
  fi

  shopt -s nullglob
  apks=("$tag_dir"/*.apk)
  shopt -u nullglob

  for apk in "${apks[@]}"; do
    # Asset names already carry the version, but namespace by tag anyway so two
    # releases can never collide into one file and silently drop a version.
    dest="$out_dir/repo/${tag}-$(basename "$apk")"
    cp "$apk" "$dest"
    echo "  $tag: $(basename "$dest")"
    apk_count=$((apk_count + 1))
  done
done

if [[ "$apk_count" -eq 0 ]]; then
  echo "No APKs were found in the last $release_count $tag_prefix releases" >&2
  exit 1
fi

echo "==> Installing the index signing keystore"
keystore="$out_dir/keystore.p12"
if [[ -n "${FDROID_KEYSTORE_FILE:-}" ]]; then
  cp "$FDROID_KEYSTORE_FILE" "$keystore"
else
  printf '%s' "$FDROID_KEYSTORE_BASE64" | base64 -d > "$keystore"
fi
chmod 600 "$keystore"

echo "==> Running fdroid update ($apk_count APK(s))"
(
  cd "$out_dir"
  fdroid update --pretty --verbose
)

# Clients pin a repo by the SHA-256 of its signing certificate, so the address to
# hand out is repo_url?fingerprint=<this>.
fingerprint=""
if command -v keytool >/dev/null 2>&1; then
  fingerprint="$(
    keytool -list -v \
      -keystore "$keystore" \
      -storetype PKCS12 \
      -alias "$FDROID_KEY_ALIAS" \
      -storepass "$FDROID_KEYSTORE_PASSWORD" 2>/dev/null \
      | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' \
      | head -1 \
      | tr -d ':' \
      | tr '[:upper:]' '[:lower:]'
  )"
fi

# The keystore must not reach the deployed site.
rm -f "$keystore"

echo
echo "F-Droid repository built in $out_dir"
echo "  APKs indexed: $apk_count"
if [[ -n "$fingerprint" ]]; then
  echo "  Fingerprint:  $fingerprint"
  printf '%s\n' "$fingerprint" > "$out_dir/fingerprint.txt"
fi
