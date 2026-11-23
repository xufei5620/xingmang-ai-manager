#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。（第十轮：试 settings.json 里的自定义型号能不能把带后缀的名字原样发出）
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

cd "$WORK/ws"
python3 "$HERE/fake_gemini.py" 18080 "$WORK/fake.log" &
sleep 1

SENT_PY='
import json, sys
marker = "### " + sys.argv[2] + "\n"
text = open(sys.argv[1], encoding="utf-8").read()
rows = text.split(marker, 1)[-1].split("\n### ", 1)[0].splitlines() if marker in text else []
seen = []
for row in rows:
    try:
        r = json.loads(row)
    except Exception:
        continue
    path = r.get("path", "")
    body = r.get("body") or {}
    level = ((body.get("generationConfig") or {}).get("thinkingConfig") or {})
    level = level.get("thinkingLevel") or level.get("thinkingBudget")
    auth = "bearer" if r.get("authBearerMatches") else ("goog-key" if r.get("googKeyMatches") else ("query-key" if r.get("queryKey") else "none"))
    method = r.get("method")
    seen.append(f"{method} {path} [{level}] auth={auth}")
print(" ; ".join(dict.fromkeys(seen)) or "(nothing sent)")
'

# custom <label> <gateway on|off> <settings json> <models to prompt, comma separated>
custom() {
  local label="$1" gateway="$2" settings="$3" picks_csv="$4"
  section "$label (gateway=$gateway)"
  export HOME="$WORK/home-$label"
  mkdir -p "$HOME/.gemini/antigravity-cli"
  printf '%s\n' "$settings" > "$HOME/.gemini/antigravity-cli/settings.json"
  cat "$HOME/.gemini/antigravity-cli/settings.json"
  local -a envs=()
  if [ "$gateway" = on ]; then
    envs=(AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS=gemini-3.8-flash)
  fi
  echo "-- menu"
  echo "### $label/menu" >> "$WORK/fake.log"
  env "${envs[@]}" timeout -k 5 40 "$AGY" models </dev/null 2>&1 | head -30 | cut -c1-300
  local IFS_SAVE="$IFS"
  IFS=',' read -r -a picks <<< "$picks_csv"
  IFS="$IFS_SAVE"
  for m in "${picks[@]}"; do
    local tag="$label/$m"
    echo "### $tag" >> "$WORK/fake.log"
    local out
    out="$(env "${envs[@]}" timeout -k 5 40 "$AGY" -p "Reply with the single word pong" --model "$m" </dev/null 2>&1 | tr '\n' ' ' | cut -c1-300)"
    printf '%-24s -> %s | %s\n' "$m" "$(python3 -c "$SENT_PY" "$WORK/fake.log" "$tag")" "$out"
  done
  echo "-- cli log lines about custom models"
  cat "$HOME"/.gemini/antigravity-cli/log/*.log 2>/dev/null | grep -a -i -E 'custom|model' | head -15 | cut -c1-300
}

custom map-gemini-api on '{"customModels":{"argon-high-raw":{"modelName":"gemini-api://http://127.0.0.1:18080/models/gemini-4-argon-high","apiKey":"probe-fake-key"},"flash37-high-raw":{"modelName":"gemini-api://http://127.0.0.1:18080/models/gemini-3.7-flash-high","apiKey":"probe-fake-key"}}}' "argon-high-raw,flash37-high-raw"
custom map-gemini-api-nogw off '{"customModels":{"argon-high-raw":{"modelName":"gemini-api://http://127.0.0.1:18080/models/gemini-4-argon-high","apiKey":"probe-fake-key"}}}' "argon-high-raw"
custom map-beyond on '{"customModels":{"argon-high-raw":{"modelName":"beyond-api://http://127.0.0.1:18080/gemini-4-argon-high","apiKey":"probe-fake-key"}}}' "argon-high-raw"
custom map-plain-name on '{"customModels":{"argon-high-raw":{"modelName":"gemini-4-argon-high"}}}' "argon-high-raw"
custom list-form on '{"customModels":[{"name":"argon-high-raw","modelName":"gemini-api://http://127.0.0.1:18080/models/gemini-4-argon-high","apiKey":"probe-fake-key"}]}' "argon-high-raw"

section "what the fake endpoint received"
cut -c1-500 "$WORK/fake.log"
exit 0
