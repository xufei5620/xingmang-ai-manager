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

# ---------------- API key mode ----------------
export HOME="$WORK/home-key"
mkdir -p "$HOME/.gemini/antigravity-cli"
echo '{ "modelProvider": "gemini" }' > "$HOME/.gemini/antigravity-cli/settings.json"

mark key-models
GEMINI_API_KEY=probe-fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080 run "key: agy models" "$AGY" models

while IFS= read -r label; do
  [ -z "$label" ] && continue
  mark "key label=$label"
  GEMINI_API_KEY=probe-fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080 run "key: --model $label" "$AGY" -p "Reply with the single word pong" --model "$label"
done <<'LABELS'
Gemini 4 Neon (High)
Gemini 4 Neon (XHigh)
Gemini 4 Neon (Low)
Gemini 4 Carbon (High)
Gemini 4 Carbon (Low)
Gemini 4 Hydrogen (High)
Gemini 4 Hydrogen (XHigh)
Gemini 4 Argon (High)
Gemini 3.8 Flash (High)
Gemini 3.8 Flash (Medium)
Gemini 3.8 Flash (Low)
Gemini 3.7 Flash (High)
Gemini 3.6 Flash (High)
Gemini 3.1 Pro (High)
Gemini 3.1 Pro (Low)
LABELS

mark "key settings model"
cat > "$HOME/.gemini/antigravity-cli/settings.json" <<'JSON'
{ "modelProvider": "gemini", "model": "Gemini 3.8 Flash (High)" }
JSON
GEMINI_API_KEY=probe-fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080 run "key: model saved in settings" "$AGY" -p "Reply with the single word pong"
mark "key --settings inline"
echo '{}' > "$HOME/.gemini/antigravity-cli/settings.json"
GEMINI_API_KEY=probe-fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080 run "key: provider via --settings only" "$AGY" --settings '{"modelProvider":"gemini","model":"Gemini 3.8 Flash (Low)"}' -p "Reply with the single word pong"
echo '{ "modelProvider": "gemini" }' > "$HOME/.gemini/antigravity-cli/settings.json"

mark "key interactive"
section "key: interactive (pseudo terminal, 25s)"
GEMINI_API_KEY=probe-fake-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080 timeout -k 2 25 script -qefc "$AGY -i 'Reply with the single word pong'" /dev/null > "$WORK/tui.txt" 2>&1
echo "[exit=$?] (tui output $(wc -c < "$WORK/tui.txt") bytes, printable tail below)"
tr -cd '[:print:]\n' < "$WORK/tui.txt" | tail -c 1500; echo

section "key: updater state and help"
cat "$HOME/.gemini/antigravity-cli/updater/update_status.json" 2>/dev/null; echo
run "update help" "$AGY" update --help
grep -i -h -E 'updat|clearcut|play.googleapis|telemetry' "$HOME"/.gemini/antigravity-cli/log/*.log 2>/dev/null | head -30 | cut -c1-300
section "key: config files written"
for f in "$HOME/.gemini/config/config.json" "$HOME/.gemini/antigravity-cli/cache/onboarding.json" "$HOME/.gemini/config/projects/default-cli-project.json"; do echo "-- $f"; head -c 1500 "$f" 2>/dev/null; echo; done

# ---------------- gateway mode ----------------
export HOME="$WORK/home-gateway"
mkdir -p "$HOME"
G="AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key"

mark "gw genai models"
env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high,claude-opus-5-5 \
  bash -c 'true'
for spec in \
  "gw genai: agy models|models" \
  "gw genai: default model|-p|Reply with the single word pong" \
  "gw genai: --model gemini-3.8-flash-high|-p|Reply with the single word pong|--model|gemini-3.8-flash-high" \
  "gw genai: --model claude-opus-5-5|-p|Reply with the single word pong|--model|claude-opus-5-5" \
  "gw genai: --model Gemini 4 Neon (High)|-p|Reply with the single word pong|--model|Gemini 4 Neon (High)" \
  "gw genai: --model Gemini 3.8 Flash (High)|-p|Reply with the single word pong|--model|Gemini 3.8 Flash (High)"; do
  IFS='|' read -r -a parts <<< "$spec"
  mark "${parts[0]}"
  AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high,claude-opus-5-5 \
    run "${parts[0]}" "$AGY" "${parts[@]:1}"
done

mark "gw genai tiers"
AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high \
AGY_LLM_GATEWAY_TIER_PRO=gemini-3.8-flash-high AGY_LLM_GATEWAY_TIER_FLASH=gemini-3.8-flash-high AGY_LLM_GATEWAY_TIER_FLASH_LITE=gemini-3.8-flash-high \
  run "gw genai with tiers: default model" "$AGY" -p "Reply with the single word pong"

mark "gw no wire protocol"
AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high \
  run "gw without wire protocol" "$AGY" -p "Reply with the single word pong" --model gemini-3.8-flash-high

mark "gw openai models"
AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080/v1 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai AGY_LLM_GATEWAY_MODELS=claude-opus-5-5,gpt-6-astra \
  run "gw openai: agy models" "$AGY" models
mark "gw openai claude"
AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080/v1 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai AGY_LLM_GATEWAY_MODELS=claude-opus-5-5,gpt-6-astra \
  run "gw openai: --model claude-opus-5-5" "$AGY" -p "Reply with the single word pong" --model claude-opus-5-5
mark "gw openai no-v1"
AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai AGY_LLM_GATEWAY_MODELS=claude-opus-5-5 \
  run "gw openai without /v1: --model claude-opus-5-5" "$AGY" -p "Reply with the single word pong" --model claude-opus-5-5

mark "gw genai google unreachable"
HTTPS_PROXY=http://127.0.0.1:18081 HTTP_PROXY=http://127.0.0.1:18081 https_proxy=http://127.0.0.1:18081 http_proxy=http://127.0.0.1:18081 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash-high \
  run "gw genai with google unreachable" "$AGY" -p "Reply with the single word pong" --model gemini-3.8-flash-high

section "gateway home tree"
find "$HOME" -maxdepth 3 -not -path '*/brain/*' | head -40
grep -i -h -E 'gateway|tier|wire' "$HOME"/.gemini/antigravity-cli/log/*.log 2>/dev/null | head -40 | cut -c1-400

section "what the fake endpoint received"
cat "$WORK/fake.log"
section "what the CLI tried to reach through the refusing proxy"
cat "$WORK/proxy.log"
exit 0
