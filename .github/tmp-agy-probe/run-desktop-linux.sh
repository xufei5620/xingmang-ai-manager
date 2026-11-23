#!/usr/bin/env bash
# 临时：核 Antigravity 桌面端认不认隐藏的网关环境变量、能不能真发一句话，核完就删。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-desktop"
mkdir -p "$WORK/app"
section() { echo; echo "================ $* ================"; }

section "download"
curl -fsS --max-time 600 -o "$WORK/app.tar.gz" https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/linux-x64/Antigravity.tar.gz || exit 1
ls -la "$WORK/app.tar.gz"
tar xzf "$WORK/app.tar.gz" -C "$WORK/app"
EXE="$(find "$WORK/app" -maxdepth 2 -type f -perm -u+x -iname antigravity | head -1)"
echo "app executable: $EXE"
command -v xvfb-run || (sudo apt-get update -qq && sudo apt-get install -y -qq xvfb >/dev/null)

section "playwright for the debug port"
PW_DIR="$WORK/pw"
export PW_DIR
mkdir -p "$PW_DIR"
(cd "$PW_DIR" && npm init -y >/dev/null && npm i --no-save --no-package-lock --registry=https://registry.npmjs.org/ playwright-core@1.62.0 >/dev/null 2>&1)
ls "$PW_DIR/node_modules" | head

python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
sleep 1

launch() {
  local label="$1"
  local port="$2"
  local mode="$3"
  shift 3
  section "launch: $label (mode=$mode)"
  echo "### $label" >> "$WORK/fake.log"
  export HOME="$WORK/home-$label"
  export XDG_CONFIG_HOME="$HOME/.config"
  mkdir -p "$HOME"
  env "$@" timeout -k 5 170 xvfb-run -a "$EXE" --no-sandbox --disable-gpu --remote-debugging-port="$port" > "$WORK/app-$label.txt" 2>&1 &
  local app_pid=$!
  timeout 160 node "$HERE/cdp-drive.cjs" "$port" "$mode"
  pkill -f "remote-debugging-port=$port" || true
  wait "$app_pid" 2>/dev/null
  section "app stdout for $label"
  grep -a -v -i -E 'dbus|gles|vaapi|viz_main|gpu_init|egl' "$WORK/app-$label.txt" | head -25 | cut -c1-300
  section "language server log for $label (noise removed)"
  local f="$HOME/.config/Antigravity/logs/language_server.log"
  if [ -f "$f" ]; then
    echo "-- $(wc -l < "$f") lines"
    sed 's/^ERROR: logging before google.Init: //' "$f" | grep -a -v -E 'RemoteControl|Migration|migration|summary store|trajectory' | grep -a -i -E '^[EW][0-9]|gateway|auth|model|tier|sign|oauth|login|cascade|request|llm|gemini|quota|user' | head -80 | cut -c1-400
  fi
  section "main log for $label"
  local m="$HOME/.config/Antigravity/logs/main.log"
  if [ -f "$m" ]; then
    grep -a -i -E 'gateway|auth|sign|login|error|warn' "$m" | head -30 | cut -c1-300
  fi
}

launch nogateway 9222 look
launch gateway 9223 chat AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash,claude-opus-5-5

section "what the fake endpoint received"
cat "$WORK/fake.log"
exit 0
