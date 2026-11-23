#!/bin/bash
# 临时：核 Mac 上 agy 的包、签名和官方安装改了什么，核完就删。只读谷歌的公开地址，不碰中转。
set -u
updater='https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
work="$RUNNER_TEMP/agy-probe"
mkdir -p "$work"
section() { printf '\n================ %s ================\n' "$1"; }
snapshot() {
  section "snapshot: $1"
  for f in .zprofile .zshrc .zshenv .zlogin .bash_profile .bashrc .profile .config/fish/config.fish; do
    if [ -e "$HOME/$f" ]; then echo "--- ~/$f"; cat "$HOME/$f"; else echo "--- ~/$f (none)"; fi
  done
  ls -la "$HOME/.config/fish/conf.d" 2>/dev/null
  for d in .local/bin .cache/antigravity .gemini .antigravity; do echo "--- ~/$d"; find "$HOME/$d" -maxdepth 4 -exec ls -ld {} \; 2>/dev/null | head -40; done
}

section 'install.sh'
curl -fsSL https://antigravity.google/cli/install.sh

for platform in darwin_arm64 darwin_amd64; do
  section "manifest $platform"
  curl -fsSL "$updater/manifests/$platform.json"; echo
done

section 'download darwin_arm64'
manifest=$(curl -fsSL "$updater/manifests/darwin_arm64.json")
url=$(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
sha=$(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha512"])')
curl -fsSL -o "$work/cli.tar.gz" "$url"
actual=$(shasum -a 512 "$work/cli.tar.gz" | cut -d' ' -f1)
echo "sha512 matches: $([ "$actual" = "$sha" ] && echo yes || echo no)"
ls -l "$work/cli.tar.gz"
tar -tvzf "$work/cli.tar.gz"
mkdir -p "$work/x" && tar -xzf "$work/cli.tar.gz" -C "$work/x"
find "$work/x" -exec ls -ld {} \;
for f in $(find "$work/x" -type f); do
  section "signature $f"
  file "$f"
  codesign -dv --verbose=4 "$f" 2>&1
  codesign -d -r- "$f" 2>&1
  codesign --verify --strict --verbose=2 "$f" 2>&1; echo "[verify exit=$?]"
  codesign --verify -R='anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"' "$f" 2>&1; echo "[requirement exit=$?]"
  spctl -a -vv -t exec "$f" 2>&1; echo "[spctl exit=$?]"
  xattr -l "$f"
done

snapshot 'before'
section 'run official install.sh'
curl -fsSL https://antigravity.google/cli/install.sh | bash 2>&1; echo "[exit=$?]"
snapshot 'after install'
agy="$HOME/.local/bin/agy"
section 'agy help'
if [ -x "$agy" ]; then
  "$agy" --version 2>&1
  "$agy" install --help 2>&1
  "$agy" uninstall --help 2>&1
  "$agy" update --help 2>&1
  codesign -dv --verbose=4 "$agy" 2>&1
  xattr -l "$agy"
  section 'agy install again with SHELL=/bin/zsh'
  SHELL=/bin/zsh "$agy" install 2>&1; echo "[exit=$?]"
fi
sleep 45
snapshot 'after 45 seconds'
