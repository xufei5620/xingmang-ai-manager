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
  export XDG_CONFIG_HOME="$HOME/.config"
  mkdir -p "$HOME"
  env "$@" timeout -k 5 60 xvfb-run -a "$EXE" --no-sandbox --disable-gpu > "$WORK/app-$label.txt" 2>&1
  echo "[exit=$?]"
  section "language server log for $label (auth, gateway, models)"
  for f in "$HOME/.config/Antigravity/logs/language_server.log" /home/runner/.config/Antigravity/logs/language_server.log; do
    [ -f "$f" ] || continue
    echo "-- $f ($(wc -l < "$f") lines)"
    grep -a -i -E 'gateway|ChainedAuth|authMethod|applyAuthResult|ModelConfig|Tier |sign.?in|oauth|login|error|fatal|panic' "$f" | head -60 | cut -c1-400
  done
  section "main log for $label"
  for f in "$HOME/.config/Antigravity/logs/main.log" /home/runner/.config/Antigravity/logs/main.log; do
    [ -f "$f" ] || continue
    echo "-- $f"; grep -a -i -E 'gateway|auth|sign|login|error' "$f" | head -30 | cut -c1-300
  done
  section "crash logs for $label"
  find "$HOME" -path '*crashes*' -name '*.log' | head -3 | while read -r c; do echo "-- $c"; head -c 2500 "$c"; echo; done
  rm -rf /home/runner/.config/Antigravity/logs
}

launch gateway AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash,claude-opus-5-5


section "what the fake endpoint received"
cat "$WORK/fake.log"
exit 0
