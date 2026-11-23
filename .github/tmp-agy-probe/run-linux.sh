#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。（第九轮重跑，grep 改快：查「自定义型号」设置怎么写、不给菜单时它会不会自己去中转查型号）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-probe"
mkdir -p "$WORK/bin" "$WORK/ws"
UPDATER=https://antigravity-cli-auto-updater-974169037036.us-central1.run.app

section() { echo; echo "================ $* ($(date +%T)) ================"; }
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

strings -n 6 "$AGY" > "$WORK/strings.txt"
wc -l "$WORK/strings.txt"
# around <needle> <before> <after> <max hits>: print the bytes around literal hits, fast (no regex over the binary)
around() {
  python3 -I -c '
import mmap, re, sys
path, needle, before, after, limit = sys.argv[1], sys.argv[2].encode(), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
with open(path, "rb") as handle:
    data = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
    start, hits = 0, 0
    while hits < limit:
        index = data.find(needle, start)
        if index < 0:
            break
        chunk = data[max(0, index - before):index + len(needle) + after]
        print("@%d: %s" % (index, re.sub(rb"[^\x20-\x7e]", b".", chunk).decode()))
        start, hits = index + len(needle), hits + 1
' "$AGY" "$1" "$2" "$3" "$4"
}
section "embedded text about custom models"
around "customModels" 300 600 12
around "custom model" 300 600 12
section "embedded text about settings files"
around "settings.json" 160 240 12
section "json field tags that look like model settings"
grep -E 'json:"' "$WORK/strings.txt" | grep -v 'protobuf:' | grep -i -E 'model|url|endpoint|apikey|api_key|thinking|display|protocol|override|header|provider|effort' | awk 'length($0) < 200' | sort -u | head -200
section "text around model_name_override"
around "model_name_override" 600 600 4
section "custom model resolver symbols"
grep -E 'customModels|CustomModel|adHocCustom|resolveGatewayModel|findKnownModelInfo|withFamilyDefaults|ensureConfiguredModels|fetchGatewayDiscovered|buildResponseFromAdminModelList' "$WORK/strings.txt" | awk 'length($0) < 200' | sort -u | head -80

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
