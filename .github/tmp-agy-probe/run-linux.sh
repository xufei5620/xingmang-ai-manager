#!/usr/bin/env bash
# 临时：核 Antigravity CLI 能不能接自定义 Gemini 地址，核完就删。（第七轮：中转 Gemini 分组 29 个型号全放进菜单，逐个看实际发出的名字）
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
sleep 1

MODELS="gemini-3.8-flash,gemini-4-argon,gemini-4-argon-high,gemini-4-hydrogen,gemini-4-hydrogen-xhigh,gemini-3.1-flash-lite,gemini-4-carbon,gemini-4-carbon-high,gemini-3.1-pro,gemini-3.1-pro-preview,gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash,gemini-3-flash-preview,gemini-3-pro-preview,gemini-3.1-pro-high,gemini-3.1-pro-low,gemini-3.5-flash-lite,gemini-3.7-flash-high,gemini-3.8-flash-high,gemini-3.8-flash-low,gemini-3.8-flash-medium,gemini-4-argon-low,gemini-4-argon-medium,gemini-4-carbon-low,gemini-4-carbon-medium,gemini-4-hydrogen-high,gemini-4-hydrogen-low,gemini-4-hydrogen-medium"
export HOME="$WORK/home-all"
mkdir -p "$HOME"
export AGY_LLM_GATEWAY_URL=http://127.0.0.1:18080 AGY_LLM_GATEWAY_API_KEY=probe-fake-key AGY_LLM_GATEWAY_WIRE_PROTOCOL=genai AGY_LLM_GATEWAY_MODELS="$MODELS"

section "menu with all 29"
timeout -k 5 60 "$AGY" models </dev/null 2>&1 | head -80

section "one prompt per menu entry"
IFS=',' read -r -a LIST <<< "$MODELS"
for m in "${LIST[@]}"; do
  echo "### $m" >> "$WORK/fake.log"
  out="$(timeout -k 5 60 "$AGY" -p "Reply with the single word pong" --model "$m" </dev/null 2>&1 | tr '\n' ' ' | cut -c1-160)"
  sent="$(python3 -c '
import json, sys
rows = open(sys.argv[1], encoding="utf-8").read().split("### " + sys.argv[2] + "\n", 1)[-1].split("\n### ", 1)[0].splitlines()
seen = []
for row in rows:
    try:
        r = json.loads(row)
    except Exception:
        continue
    path = r.get("path", "")
    model = path.split("/models/", 1)[-1].split(":", 1)[0] if "/models/" in path else path
    level = (((r.get("body") or {}).get("generationConfig") or {}).get("thinkingConfig") or {})
    level = level.get("thinkingLevel") or level.get("thinkingBudget")
    seen.append(f"{model}[{level}]")
print(" ".join(dict.fromkeys(seen)) or "(nothing sent)")
' "$WORK/fake.log" "$m")"
  printf '%-28s -> %s | %s\n' "$m" "$sent" "$out"
done
exit 0
