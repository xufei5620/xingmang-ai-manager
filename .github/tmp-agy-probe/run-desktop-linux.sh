#!/usr/bin/env bash
# 临时：核 Antigravity 桌面端认不认隐藏的网关环境变量，核完就删。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-desktop"
mkdir -p "$WORK/app"
section() { echo; echo "================ $* ================"; }

section "download"
curl -fsS --max-time 600 -o "$WORK/app.tar.gz" https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/linux-x64/Antigravity.tar.gz || exit 1
ls -la "$WORK/app.tar.gz"
tar xzf "$WORK/app.tar.gz" -C "$WORK/app"
find "$WORK/app" -maxdepth 2 | head -40

section "binaries mentioning the gateway"
find "$WORK/app" -type f -size +1M | while read -r f; do
  if grep -q -a AGY_LLM_GATEWAY_URL "$f" 2>/dev/null; then
    echo "-- $f ($(stat -c %s "$f") bytes)"
    grep -a -o -E 'AGY_LLM_GATEWAY_[A-Z_]+' "$f" | sort -u | tr '\n' ' '; echo
  fi
done
LS="$(find "$WORK/app" -type f -iname '*language_server*' | head -1)"
echo "language server: $LS"
EXE="$(find "$WORK/app" -maxdepth 2 -type f -perm -u+x \( -iname antigravity -o -iname 'antigravity-hub' -o -iname 'Antigravity' \) | head -1)"
echo "app executable: $EXE"
command -v xvfb-run || (sudo apt-get update -qq && sudo apt-get install -y -qq xvfb >/dev/null)

python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
sleep 1

launch() {
  local label="$1"; shift
  section "launch: $label"
  echo "### $label" >> "$WORK/fake.log"
  export HOME="$WORK/home-$label"
  mkdir -p "$HOME"
  env "$@" timeout -k 5 75 xvfb-run -a "$EXE" --no-sandbox --disable-gpu > "$WORK/app-$label.txt" 2>&1
  echo "[exit=$?]"
  tr -cd '[:print:]\n' < "$WORK/app-$label.txt" | grep -v -i -E 'dbus|gpu|libva|vaapi' | tail -60 | cut -c1-300
  section "files and logs for $label"
  find "$HOME" -maxdepth 4 -iname '*.log' | head -20
  find "$HOME" -iname '*.log' -size -5M -print0 2>/dev/null | xargs -0 grep -h -i -E 'gateway|AGY_LLM|wire|tier|model' 2>/dev/null | head -60 | cut -c1-400
}

launch gateway AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high,claude-opus-5-5
launch plain DUMMY=1

if [ -n "$LS" ]; then
  section "language server help"
  timeout 20 "$LS" --help 2>&1 | head -80 | cut -c1-200
fi

section "what the fake endpoint received"
cat "$WORK/fake.log"
exit 0
