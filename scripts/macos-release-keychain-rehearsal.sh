#!/bin/bash
# 在 PR 上排练正式发布的 macOS 签名身份这一段。
#
# 为什么要有这个：publish-release.yml 的 macos-build 作业挂 `environment: release`，
# PR 上从来不跑，于是 scripts/macos-release-keychain.cjs 这条链路唯一的验证机会就是
# 真的发一次版——而每发一次都要产品所有者点一次批准。2026-09-20 连红四次，其中两次
# （信任设置挂死、同一身份被列两次判成歧义）都是这一段的问题，本来都该在 PR 上就红。
#
# 这里用现场生成的一张一次性证书，profile 与已发布那张相同（CA:TRUE、pathlen:0、
# keyCertSign、critical codeSigning EKU、7300 天），走与发布作业**完全相同**的脚本，
# 断言三件事：导入之后身份恰好一个且真的能签、撤销能正常退出、撤销之后不留痕迹。
# 不读任何 secret，所以不需要 release 环境的批准。
#
# 没有覆盖到的：dist:mac:free 的完整打包与产物校验（那一段由 quality.yml 的
# macos-test 用一次性签名身份覆盖）、台账指纹的跨版本连续性核对（发布时才有意义）。
set -euo pipefail

work="${RUNNER_TEMP:-/tmp}/release-keychain-rehearsal"
rm -rf "$work"
mkdir -p "$work"

name='XingMang Release Rehearsal Identity'
p12pass='RehearsalP12Pass1234!aA'
state="$work/state.json"

printf '%s\n' \
  '[req]' 'distinguished_name = dn' 'prompt = no' \
  '[dn]' "CN = $name" \
  '[ca_ext]' \
  'basicConstraints = critical,CA:TRUE,pathlen:0' \
  'keyUsage = critical,digitalSignature,keyCertSign' \
  'extendedKeyUsage = critical,codeSigning' \
  'subjectKeyIdentifier = hash' > "$work/rehearsal.cnf"

/usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "$work/rehearsal.key" \
  -out "$work/rehearsal.crt" -days 7300 -nodes \
  -config "$work/rehearsal.cnf" -extensions ca_ext 2> /dev/null
/usr/bin/openssl pkcs12 -export -inkey "$work/rehearsal.key" -in "$work/rehearsal.crt" \
  -out "$work/rehearsal.p12" -name "$name" -passout "pass:$p12pass"

sha256=$(/usr/bin/openssl x509 -in "$work/rehearsal.crt" -noout -fingerprint -sha256 \
  | /usr/bin/sed -e 's/.*=//' -e 's/://g')
sha1=$(/usr/bin/openssl x509 -in "$work/rehearsal.crt" -noout -fingerprint -sha1 \
  | /usr/bin/sed -e 's/.*=//' -e 's/://g')
echo "排练证书 SHA-1=$sha1"

before=$(security list-keychains -d user)

# 与 publish-release.yml 的 macos-build 传的是同一组变量名。
export CSC_NAME="$name"
export XINGMANG_MAC_SIGNING_P12_BASE64
XINGMANG_MAC_SIGNING_P12_BASE64=$(/usr/bin/base64 < "$work/rehearsal.p12" | /usr/bin/tr -d '\n')
export XINGMANG_MAC_SIGNING_P12_PASSWORD="$p12pass"
export XINGMANG_MAC_SIGNING_SHA256="$sha256"

node scripts/macos-release-keychain.cjs --import --state "$state"

# 第四次正式发布红在这里：信任设置生效了，但同一个身份被列了两次，
# verify-macos-free-signing.cjs 的「匹配项恰好一个」判成歧义。
matches=$(security find-identity -v -p codesigning | /usr/bin/grep -c "$name" || true)
echo "find-identity -v -p codesigning 里匹配 CSC_NAME 的项：$matches"
if [ "$matches" != "1" ]; then
  echo "排练失败：匹配项应为 1，实际 $matches。发布预检会把这判成「不存在或存在选择歧义」。" >&2
  exit 1
fi

# 列出来不等于能用。真的签一个二进制，再验一遍。
cp /bin/echo "$work/probe-binary"
chmod 755 "$work/probe-binary"
/usr/bin/codesign --force --sign "$sha1" --timestamp=none --options runtime "$work/probe-binary"
/usr/bin/codesign --verify --strict --verbose=2 "$work/probe-binary"

# 撤销必须能正常退出。第四次发布的第二条 exit code 1 就是撤销自己挂死/报错。
node scripts/macos-release-keychain.cjs --release --state "$state"

after=$(security list-keychains -d user)
if [ "$before" != "$after" ]; then
  echo "排练失败：keychain 搜索列表没有还原。" >&2
  printf '撤销前：\n%s\n撤销后：\n%s\n' "$before" "$after" >&2
  exit 1
fi
if [ -f "$state" ]; then
  echo "排练失败：状态文件没有删掉。" >&2
  exit 1
fi
if security find-identity -v -p codesigning | /usr/bin/grep -q "$name"; then
  echo "排练失败：撤销之后排练身份还在。" >&2
  exit 1
fi

rm -rf "$work"
echo 'macOS 发布签名身份排练通过：导入、签名、撤销、还原四步都对'
