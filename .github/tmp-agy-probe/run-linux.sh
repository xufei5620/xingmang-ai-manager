#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。（第二轮：逐个型号、网关模式）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-probe"
mkdir -p "$WORK/bin" "$WORK/ws"
UPDATER=https://antigravity-cli-auto-updater-974169037036.us-central1.run.app

section() { echo; echo "================ $* ================"; }

MANIFEST="$(curl -fsS --max-time 30 "$UPDATER/manifests/linux_amd64.json")"
echo "$MANIFEST"
URL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$MANIFEST")"
SHA="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sha512"])' "$MANIFEST")"
curl -fsS --max-time 300 -o "$WORK/agy.tar.gz" "$URL"
echo "$SHA  $WORK/agy.tar.gz" | sha512sum -c - || exit 1
tar xzf "$WORK/agy.tar.gz" -C "$WORK/bin"
AGY="$WORK/bin/antigravity"
"$AGY" --version

cd "$WORK/ws"
python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
python3 "$HERE/refusing_proxy.py" 18081 "$WORK/proxy.log" &
sleep 1

mark() { echo "### $*" >> "$WORK/fake.log"; echo "### $*" >> "$WORK/proxy.log"; }

run() {
  local label="$1"; shift
  section "$label"
  local start end
  start=$(date +%s.%N)
  timeout -k 5 90 "$@" </dev/null > "$WORK/out.txt" 2>&1
  local code=$?
  end=$(date +%s.%N)
  head -c 4000 "$WORK/out.txt"
  echo
  echo "[exit=$code seconds=$(python3 -c "print(round($end-$start,2))")]"
}

# ---------------- round 3 ----------------
GW_GENAI="AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai"
export HOME="$WORK/home-gw3"
mkdir -p "$HOME"

mark "gw openai gemini-3.8-flash-high"
env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high,gpt-6-astra-high \
  bash -c '"$0" models; "$0" -p "Reply with the single word pong" --model gemini-3.8-flash-high; "$0" -p "Reply with the single word pong" --model gpt-6-astra-high' "$AGY" </dev/null 2>&1 | head -40

mark "gw genai odd names"
env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS="gemini-3.8-flash,gemini-4-neon,gemini-3.1-pro-preview,gemini-3.8-flash-high" \
  bash -c '"$0" models; for m in gemini-3.8-flash gemini-4-neon gemini-3.1-pro-preview; do echo "-- $m"; "$0" -p "Reply with the single word pong" --model "$m"; done' "$AGY" </dev/null 2>&1 | head -60

for variant in plain tiers; do
  mark "gw interactive $variant"
  section "gw interactive $variant (pseudo terminal, 30s)"
  rm -rf "$HOME/.gemini"
  mkdir -p "$HOME/.gemini/antigravity-cli"
  echo '{ "colorScheme": "dark" }' > "$HOME/.gemini/antigravity-cli/settings.json"
  extra=""
  [ "$variant" = tiers ] && extra="AGY_LLM_GATEWAY_TIER_PRO=gemini-3.8-flash AGY_LLM_GATEWAY_TIER_FLASH=gemini-3.8-flash AGY_LLM_GATEWAY_TIER_FLASH_LITE=gemini-3.8-flash"
  env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash,claude-opus-5-5 $extra \
    timeout -k 2 30 script -qefc "$AGY -i 'Reply with the single word pong'" /dev/null > "$WORK/tui.txt" 2>&1
  echo "[exit=$?]"
  tr -cd '[:print:]\n' < "$WORK/tui.txt" | tail -c 1200; echo
done

section "auto-update switch candidates"
export HOME="$WORK/home-update"
mkdir -p "$HOME/.gemini/antigravity-cli"
echo '{ "modelProvider": "gemini" }' > "$HOME/.gemini/antigravity-cli/settings.json"
for var in DISABLE_AUTOUPDATER DISABLE_AUTO_UPDATE AGY_DISABLE_AUTO_UPDATE AGY_DISABLE_AUTOUPDATE AGY_DISABLE_UPDATES AGY_NO_AUTO_UPDATE AGY_CLI_DISABLE_AUTO_UPDATE AGY_CLI_DISABLE_AUTOUPDATE ANTIGRAVITY_DISABLE_AUTO_UPDATE ANTIGRAVITY_CLI_DISABLE_AUTO_UPDATE AGY_SKIP_AUTO_UPDATE AGY_AUTO_UPDATE NO_AUTO_UPDATE; do
  rm -rf "$HOME/.gemini/antigravity-cli/log" "$HOME/.gemini/antigravity-cli/last_check.timestamp" "$HOME/.gemini/antigravity-cli/updater"
  value=1
  [ "$var" = AGY_AUTO_UPDATE ] && value=false
  env "$var=$value" GEMINI_API_KEY=probe-fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080 timeout 60 "$AGY" -p "Reply with the single word pong" </dev/null >/dev/null 2>&1
  hit="$(grep -h -E 'Auto-update disabled|auto_updater' "$HOME"/.gemini/antigravity-cli/log/*.log 2>/dev/null | head -3 | cut -c1-200)"
  echo "$var=$value -> ${hit:-<no updater line>}"
done

section "what the fake endpoint received"
cat "$WORK/fake.log"
section "what the CLI tried to reach through the refusing proxy"
cat "$WORK/proxy.log"
exit 0
