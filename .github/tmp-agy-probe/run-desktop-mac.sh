#!/usr/bin/env bash
# 临时：核 Mac 版 Antigravity 桌面端的签名、带网关设置启动能不能用（直接运行和 open --env 两种），核完就删。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-desktop"
mkdir -p "$WORK/mnt"
section() { echo; echo "================ $* ================"; }

section "download and mount"
curl -fsS --max-time 600 -o "$WORK/Antigravity.dmg" https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/darwin-arm/Antigravity.dmg || exit 1
ls -la "$WORK/Antigravity.dmg"
hdiutil attach -nobrowse -readonly -mountpoint "$WORK/mnt" "$WORK/Antigravity.dmg" >/dev/null
ls "$WORK/mnt"
SRC="$(ls -d "$WORK/mnt"/*.app | head -1)"
cp -R "$SRC" "$WORK/"
hdiutil detach "$WORK/mnt" >/dev/null
APP="$WORK/$(basename "$SRC")"
echo "app: $APP"

section "bundle facts and signature"
for key in CFBundleIdentifier CFBundleShortVersionString CFBundleExecutable LSMinimumSystemVersion; do
  echo "$key = $(/usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" 2>/dev/null)"
done
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|Timestamp|Runtime'
spctl -a -vv "$APP" 2>&1 | head -5
EXE="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
LS="$(find "$APP" -type f -name 'language_server*' | head -1)"
echo "exe: $EXE"
echo "language server: $LS"
[ -n "$LS" ] && grep -a -o -E 'AGY_LLM_GATEWAY_[A-Z_]+' "$LS" | sort -u | tr '\n' ' '; echo

section "playwright for the debug port"
PW_DIR="$WORK/pw"
export PW_DIR
mkdir -p "$PW_DIR"
(cd "$PW_DIR" && npm init -y >/dev/null && npm i --no-save --no-package-lock --registry=https://registry.npmjs.org/ playwright-core@1.62.0 >/dev/null 2>&1)
ls "$PW_DIR/node_modules" | head

python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
sleep 1

GATEWAY_ENV=(AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash,claude-opus-5-5)

section "direct run of the bundle executable with gateway settings"
echo "### direct" >> "$WORK/fake.log"
env "${GATEWAY_ENV[@]}" "$EXE" --remote-debugging-port=9227 > "$WORK/app-direct.txt" 2>&1 &
APP_PID=$!
node "$HERE/cdp-drive.cjs" 9227 chat
kill "$APP_PID" 2>/dev/null
pkill -f "$EXE" 2>/dev/null
sleep 5

section "open -n --env (LaunchServices) with gateway settings"
echo "### open-env" >> "$WORK/fake.log"
OPEN_ARGS=()
for pair in "${GATEWAY_ENV[@]}"; do OPEN_ARGS+=(--env "$pair"); done
open -n "${OPEN_ARGS[@]}" -a "$APP" --args --remote-debugging-port=9228
echo "[open exit=$?]"
node "$HERE/cdp-drive.cjs" 9228 chat
pkill -f "$EXE" 2>/dev/null
sleep 3

section "language server log lines"
find "$HOME/Library" "$HOME/.config" -name language_server.log 2>/dev/null | head -3 | while read -r f; do
  echo "-- $f"
  sed 's/^ERROR: logging before google.Init: //' "$f" | grep -a -E 'Gateway|Auth succeeded|ModelConfig|not logged' | head -15 | cut -c1-300
done

section "what the fake endpoint received"
cut -c1-700 "$WORK/fake.log"
exit 0
