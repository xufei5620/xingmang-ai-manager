#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。（第九轮：查「自定义型号」设置怎么写、不给菜单时它会不会自己去中转查型号）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-probe"
mkdir -p "$WORK/bin" "$WORK/ws"
UPDATER=https://antigravity-cli-auto-updater-974169037036.us-central1.run.app

section() { echo; echo "================ $* ================"; }
printable() { tr -c '[:print:]\n' '.'; }

MANIFEST="$(curl -fsS --max-time 30 "$UPDATER/manifests/linux_amd64.json")"
URL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$MANIFEST")"
SHA="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sha512"])' "$MANIFEST")"
curl -fsS --max-time 300 -o "$WORK/agy.tar.gz" "$URL"
echo "$SHA  $WORK/agy.tar.gz" | sha512sum -c - || exit 1
tar xzf "$WORK/agy.tar.gz" -C "$WORK/bin"
AGY="$WORK/bin/antigravity"
"$AGY" --version

section "help"
export HOME="$WORK/home-help"
mkdir -p "$HOME"
timeout -k 5 30 "$AGY" --help </dev/null 2>&1 | head -80
section "models help"
timeout -k 5 30 "$AGY" models --help </dev/null 2>&1 | head -40

section "embedded text about custom models"
grep -a -o -E '.{0,300}[Cc]ustom[ _]?[Mm]odels?.{0,500}' "$AGY" | printable | grep -v -E 'protobuf:|\*func|\*map' | awk 'length($0) > 80' | sort -u | head -30 | cut -c1-900
section "embedded text about settings files"
grep -a -o -E '.{0,160}settings\.json.{0,200}' "$AGY" | printable | sort -u | head -30 | cut -c1-400
section "json field tags that look like model settings"
strings -n 6 "$AGY" | grep -E 'json:"' | grep -v 'protobuf:' | grep -i -E 'model|url|endpoint|apikey|api_key|thinking|display|protocol|override|header|provider|effort' | awk 'length($0) < 200' | sort -u | head -200
section "text around model_name_override"
grep -a -o -E '.{0,500}model_name_override.{0,500}' "$AGY" | printable | head -6 | cut -c1-1100
section "custom model resolver symbols"
strings -n 6 "$AGY" | grep -E 'customModels|CustomModel|adHocCustom|resolveGatewayModel|findKnownModelInfo|withFamilyDefaults|ensureConfiguredModels|fetchGatewayDiscovered|buildResponseFromAdminModelList' | awk 'length($0) < 200' | sort -u | head -80

cd "$WORK/ws"
python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
sleep 1

section "no menu given: does it discover models from the gateway?"
export HOME="$WORK/home-discover"
mkdir -p "$HOME"
echo "### discover" >> "$WORK/fake.log"
env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai \
  timeout -k 5 60 "$AGY" models </dev/null 2>&1 | head -40
echo "-- prompt with gemini-3.1-pro-preview (listed by the fake)"
env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai \
  timeout -k 5 60 "$AGY" -p "Reply with the single word pong" --model gemini-3.1-pro-preview </dev/null 2>&1 | head -5 | cut -c1-300
echo "-- prompt with the default"
env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai \
  timeout -k 5 60 "$AGY" -p "Reply with the single word pong" </dev/null 2>&1 | head -5 | cut -c1-300
echo "-- files agy wrote under HOME"
find "$HOME" -maxdepth 4 -type f | head -40
for f in $(find "$HOME" -maxdepth 4 -type f -name '*.json' | head -10); do echo "== $f"; head -c 1500 "$f" | printable; echo; done

section "what the fake endpoint received"
cat "$WORK/fake.log" | cut -c1-600
exit 0
