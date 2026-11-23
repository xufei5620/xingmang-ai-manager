set -u
feed_root='https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/'
work="$RUNNER_TEMP/agy-desktop2"
mkdir -p "$work"
requirement='identifier "com.google.antigravity" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EQHXZ8M8AV"'
for chip in x64 arm64; do
  echo "================ $chip zip ================"
  feed=$(curl -fsSL "${feed_root}latest-${chip}-mac.yml")
  echo "$feed"
  url=$(printf '%s\n' "$feed" | sed -n 's/^  - url: //p')
  sha=$(printf '%s\n' "$feed" | sed -n 's/^    sha512: //p')
  zip="$work/Antigravity-$chip.zip"
  curl -fsSL -D "$work/headers-$chip.txt" -o "$zip" "$url"
  grep -i '^content-type\|^content-length\|^location' "$work/headers-$chip.txt"
  actual=$(openssl dgst -sha512 -binary "$zip" | base64)
  echo "sha512 matches feed: $([ "$actual" = "$sha" ] && echo true || echo false)"
  out="$work/extract-$chip"
  mkdir -p "$out"
  /usr/bin/tar -xf "$zip" -C "$out"; echo "bsdtar exit=$?"
  ls -la "$out"
  app="$out/Antigravity.app"
  echo "symlinks: $(find "$app" -type l | wc -l)"
  echo "hard links >1: $(find "$app" -type f -links +1 | wc -l)"
  /usr/bin/plutil -convert json -o - "$app/Contents/Info.plist" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ["CFBundleIdentifier","CFBundleShortVersionString","CFBundleExecutable","LSMinimumSystemVersion","LSRequiresNativeExecution"]})'
  lipo -archs "$app/Contents/MacOS/Antigravity"
  /usr/bin/codesign --verify --strict --deep "-R=$requirement" "$app"; echo "codesign requirement exit=$?"
  /usr/sbin/spctl --assess --type execute -vv "$app"; echo "spctl exit=$?"
  du -sh "$app"
done
