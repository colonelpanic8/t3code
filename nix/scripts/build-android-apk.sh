# Build a debug-signed release APK from this flake's T3 Code source.
#
# Environment overrides:
#   T3CODE_APK_WORKDIR  writable build tree (default ~/.cache/t3code-apk-build)
#   T3CODE_APK_OUT      output directory (default ~/t3code-apk)
#   T3CODE_APK_VARIANT  APP_VARIANT (default production)
#   T3CODE_APK_ABIS     comma-separated Android ABIs (default arm64-v8a)

workdir="${T3CODE_APK_WORKDIR:-$HOME/.cache/t3code-apk-build}"
outdir="${T3CODE_APK_OUT:-$HOME/t3code-apk}"
variant="${T3CODE_APK_VARIANT:-production}"
abis="${T3CODE_APK_ABIS:-arm64-v8a}"

log() {
  printf '\n\033[1;34m==> %s\033[0m\n' "$*"
}

case "$workdir" in
  "" | "/" | "$HOME")
    echo "Refusing unsafe T3CODE_APK_WORKDIR: $workdir" >&2
    exit 64
    ;;
esac

work_parent="$(dirname "$workdir")"
mkdir -p "$work_parent"

avail_kb="$(df -Pk "$work_parent" | awk 'NR==2 {print $4}')"
if [ "${avail_kb:-0}" -lt 20971520 ]; then
  printf '\033[1;33mWARNING: only %s GiB free near %s; React Native builds can need 15-20 GiB.\033[0m\n' \
    "$((avail_kb / 1048576))" "$workdir" >&2
fi

log "Refreshing writable source tree at $workdir"
rm -rf -- "$workdir"
mkdir -p "$workdir"
cp -a "$T3CODE_SOURCE_TREE"/. "$workdir"/
chmod -R u+w "$workdir"

log "Building the release APK"
cd "$workdir"
nix develop "$T3CODE_ANDROID_FLAKE#android" --command bash -euo pipefail -c '
  CI=true corepack pnpm install \
    --frozen-lockfile \
    --config.enableGlobalVirtualStore=false

  cd apps/mobile
  APP_VARIANT="'"$variant"'" EXPO_NO_GIT_STATUS=1 \
    expo prebuild --clean --platform android

  cd android
  NODE_ENV=production ./gradlew assembleRelease \
    -PreactNativeArchitectures="'"$abis"'" \
    -x lintVitalAnalyzeRelease \
    -x lintVitalReportRelease \
    -x lintVitalRelease \
    --no-daemon \
    --max-workers=4
'

apk="$workdir/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$apk" ]; then
  echo "Expected APK not found at $apk" >&2
  exit 1
fi

mkdir -p "$outdir"
destination="$outdir/t3code-${variant}-${T3CODE_SOURCE_REV}.apk"
cp -f "$apk" "$destination"

log "APK ready"
echo "$destination"
echo "Sideload with: adb install -r \"$destination\""
