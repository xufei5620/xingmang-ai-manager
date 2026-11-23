#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。（第八轮：找办法让菜单里的型号名原样发出，不被拆成型号+思考强度）
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
ls -la "$WORK/bin"
AGY="$WORK/bin/antigravity"
"$AGY" --version
file "$AGY"

section "env var names in the binary"
strings -n 6 "$AGY" | grep -o -E 'AGY_[A-Z0-9_]{3,}' | sort -u
section "text around the models variable"
grep -a -o -E '.{0,160}AGY_LLM_GATEWAY_MODELS.{0,400}' "$AGY" | tr -c '[:print:]\n' '.' | head -12 | cut -c1-600
section "gateway symbols"
strings -n 6 "$AGY" | grep -E '[Gg]ateway' | awk 'length($0) < 220' | sort -u | head -200
section "model alias / passthrough / suffix symbols"
strings -n 6 "$AGY" | grep -i -E 'alias|passthrough|verbatim|override|suffix|custom.?model|raw.?model' | grep -i -E 'model|gateway|thinking' | awk 'length($0) < 220' | sort -u | head -120
section "thinking level symbols"
strings -n 6 "$AGY" | grep -i -E 'thinking.?level|thinkingBudget|xhigh' | awk 'length($0) < 220' | sort -u | head -80
section "known model table around gemini-3.1-pro-preview"
grep -a -o -E '.{0,300}gemini-3\.1-pro-preview.{0,300}' "$AGY" | tr -c '[:print:]\n' '.' | head -8 | cut -c1-700

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
    model = body.get("model") or (path.split("/models/", 1)[-1].split(":", 1)[0] if "/models/" in path else path)
    level = ((body.get("generationConfig") or {}).get("thinkingConfig") or {})
    level = level.get("thinkingLevel") or level.get("thinkingBudget") or body.get("reasoning_effort") or body.get("reasoning")
    seen.append(f"{path} model={model}[{level}]")
print(" ; ".join(dict.fromkeys(seen)) or "(nothing sent)")
'

# probe <label> <protocol> <models list> <entries to prompt, comma separated>
probe() {
  local label="$1" protocol="$2" models="$3" entries="$4"
  section "$label (protocol=$protocol)"
  echo "AGY_LLM_GATEWAY_MODELS=$models"
  export HOME="$WORK/home-$label"
  mkdir -p "$HOME"
  echo "-- menu"
  env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key \
    AGY_LLM_GATEWAY_WIRE_PROTOCOL="$protocol" AGY_LLM_GATEWAY_MODELS="$models" \
    timeout -k 5 60 "$AGY" models </dev/null 2>&1 | head -30 | cut -c1-200
  local IFS_SAVE="$IFS"
  IFS=',' read -r -a picks <<< "$entries"
  IFS="$IFS_SAVE"
  for m in "${picks[@]}"; do
    local tag="$label/$m"
    echo "### $tag" >> "$WORK/fake.log"
    local out
    out="$(env AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key \
      AGY_LLM_GATEWAY_WIRE_PROTOCOL="$protocol" AGY_LLM_GATEWAY_MODELS="$models" \
      timeout -k 5 60 "$AGY" -p "Reply with the single word pong" --model "$m" </dev/null 2>&1 | tr '\n' ' ' | cut -c1-200)"
    local sent
    sent="$(python3 -c "$SENT_PY" "$WORK/fake.log" "$tag")"
    printf '%-40s -> %s | %s\n' "$m" "$sent" "$out"
  done
}

TRICKY="gemini-4-argon-high,gemini-3.7-flash-high,gemini-3.1-pro-preview,gemini-3.1-pro-high,gemini-3.8-flash-medium"

probe openai openai "gemini-3.8-flash,$TRICKY" "gemini-3.8-flash,$TRICKY"
probe prefix genai "models/gemini-3.8-flash,models/gemini-4-argon-high,models/gemini-3.7-flash-high,models/gemini-3.1-pro-preview" "models/gemini-3.8-flash,models/gemini-4-argon-high,models/gemini-3.7-flash-high,models/gemini-3.1-pro-preview"
probe upper genai "gemini-3.8-flash,GEMINI-4-ARGON-HIGH,Gemini-3.1-Pro-Preview" "GEMINI-4-ARGON-HIGH,Gemini-3.1-Pro-Preview"
probe equals genai "gemini-3.8-flash,gemini-4-argon-high=Argon High" "gemini-4-argon-high=Argon High,gemini-4-argon-high"
probe colon genai "gemini-3.8-flash,gemini-4-argon-high:raw" "gemini-4-argon-high:raw,gemini-4-argon-high"
probe pipe genai "gemini-3.8-flash,gemini-4-argon-high|raw" "gemini-4-argon-high|raw,gemini-4-argon-high"
probe json genai '[{"id":"gemini-4-argon-high","name":"gemini-4-argon-high","displayName":"raw"}]' "gemini-4-argon-high"
exit 0
