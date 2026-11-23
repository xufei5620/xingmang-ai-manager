#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUNNER_TEMP/agy-probe"
mkdir -p "$WORK/bin" "$WORK/ws"
UPDATER=https://antigravity-cli-auto-updater-974169037036.us-central1.run.app

section() { echo; echo "================ $* ================"; }

section "manifests"
for p in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64 windows_amd64 windows_arm64; do
  echo "-- $p"; curl -fsS --max-time 30 "$UPDATER/manifests/$p.json"; echo
done

section "download linux_amd64"
MANIFEST="$(curl -fsS --max-time 30 "$UPDATER/manifests/linux_amd64.json")"
URL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$MANIFEST")"
SHA="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sha512"])' "$MANIFEST")"
curl -fsS --max-time 300 -o "$WORK/agy.tar.gz" "$URL"
echo "$SHA  $WORK/agy.tar.gz" | sha512sum -c - || exit 1
tar xzf "$WORK/agy.tar.gz" -C "$WORK/bin"
ls -la "$WORK/bin"
AGY="$WORK/bin/antigravity"

export HOME="$WORK/home"
mkdir -p "$HOME"
cd "$WORK/ws"

run() {
  local label="$1"; shift
  section "$label"
  local start end
  start=$(date +%s.%N)
  timeout -k 5 120 "$@" </dev/null > "$WORK/out.txt" 2>&1
  local code=$?
  end=$(date +%s.%N)
  head -c 6000 "$WORK/out.txt"
  echo
  echo "[exit=$code seconds=$(python3 -c "print(round($end-$start,2))")]"
}

run "version" "$AGY" --version
run "help" "$AGY" --help
run "models help" "$AGY" models --help
run "install help" "$AGY" install --help

section "files after help (no sign-in yet)"
find "$HOME" -maxdepth 4 | head -50

python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
python3 "$HERE/refusing_proxy.py" 18081 "$WORK/proxy.log" &
sleep 1

mkdir -p "$HOME/.gemini/antigravity-cli"
echo '{ "modelProvider": "gemini" }' > "$HOME/.gemini/antigravity-cli/settings.json"
export GEMINI_API_KEY=probe-fake-key
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080

mark() { echo "### $*" >> "$WORK/fake.log"; echo "### $*" >> "$WORK/proxy.log"; }

mark models-json
run "models json (api key mode)" "$AGY" models --output-format json
cp "$WORK/out.txt" "$WORK/models.json"

mark print-default
run "print default model" "$AGY" -p "Reply with the single word pong"

section "settings.json after first run"
cat "$HOME/.gemini/antigravity-cli/settings.json"; echo
find "$HOME" -maxdepth 4 -newer "$WORK/agy.tar.gz" | head -60

python3 - "$WORK/models.json" > "$WORK/model-ids.txt" <<'PY'
import json, sys
text = open(sys.argv[1], encoding='utf-8', errors='replace').read()
start = min([i for i in (text.find('['), text.find('{')) if i >= 0] or [0])
try:
    data = json.loads(text[start:])
except Exception as error:
    print('#parse-failed', error, file=sys.stderr)
    sys.exit(0)
seen = []
def walk(node):
    if isinstance(node, dict):
        for key in ('id', 'model', 'name', 'label', 'modelId'):
            value = node.get(key)
            if isinstance(value, str) and value not in seen:
                seen.append(value)
                break
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
walk(data)
for value in seen[:16]:
    print(value)
PY
section "model ids parsed"
cat "$WORK/model-ids.txt"

while IFS= read -r id; do
  [ -z "$id" ] && continue
  mark "model=$id"
  run "print --model $id" "$AGY" -p "Reply with the single word pong" --model "$id"
done < "$WORK/model-ids.txt"

section "custom models"
cat > "$HOME/.gemini/antigravity-cli/settings.json" <<'JSON'
{
  "modelProvider": "gemini",
  "customModelsConfig": {
    "customModels": {
      "xm-a": { "modelName": "gemini-api://127.0.0.1:18080/models/xm-custom-a", "label": "XM Custom A" },
      "xm-b": { "modelName": "gemini-api://http://127.0.0.1:18080/models/xm-custom-b", "label": "XM Custom B" },
      "xm-c": { "modelName": "gemini-api://localhost:18080/models/xm-custom-c", "label": "XM Custom C" }
    }
  }
}
JSON
mark custom-models-json
run "models json with custom models" "$AGY" models --output-format json
for label in "XM Custom A" "XM Custom B" "XM Custom C" "gemini-api://127.0.0.1:18080/models/xm-custom-d"; do
  mark "custom=$label"
  run "print custom $label" "$AGY" -p "Reply with the single word pong" --model "$label"
done

section "custom models as list"
cat > "$HOME/.gemini/antigravity-cli/settings.json" <<'JSON'
{
  "modelProvider": "gemini",
  "customModelsConfig": {
    "customModels": [
      { "modelName": "gemini-api://127.0.0.1:18080/models/xm-custom-e", "label": "XM Custom E" }
    ]
  }
}
JSON
mark custom-list
run "models json with list-shaped custom models" "$AGY" models --output-format json
run "print custom E" "$AGY" -p "Reply with the single word pong" --model "XM Custom E"

echo '{ "modelProvider": "gemini" }' > "$HOME/.gemini/antigravity-cli/settings.json"

section "base url with path prefix"
mark base-prefix
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18080/prefix run "print with base prefix" "$AGY" -p "Reply with the single word pong"

section "google unreachable (every non-loopback connection refused)"
mark no-google
HTTPS_PROXY=http://127.0.0.1:18081 HTTP_PROXY=http://127.0.0.1:18081 https_proxy=http://127.0.0.1:18081 http_proxy=http://127.0.0.1:18081 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  run "print with google unreachable" "$AGY" -p "Reply with the single word pong"
mark no-google-second
HTTPS_PROXY=http://127.0.0.1:18081 HTTP_PROXY=http://127.0.0.1:18081 https_proxy=http://127.0.0.1:18081 http_proxy=http://127.0.0.1:18081 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  run "print with google unreachable (second run)" "$AGY" -p "Reply with the single word pong"

section "what the fake endpoint received"
cat "$WORK/fake.log"
section "what the CLI tried to reach through the refusing proxy"
cat "$WORK/proxy.log"
section "home tree at end"
find "$HOME" -maxdepth 5 -not -path '*/node_modules/*' | head -120
section "binary location after runs (self-update?)"
ls -la "$WORK/bin" "$HOME/.local/bin" 2>/dev/null
