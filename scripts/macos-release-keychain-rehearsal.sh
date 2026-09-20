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
# 带 --with-release-build 时再往后走完整条发布路径：用这个身份跑一次真正的
# `dist:mac:free`（按架构分两次构建再合并、带私有加速线路）、产物校验与启动冒烟。
# 那一段需要事先准备好两个架构的加速资源目录，路径由 REHEARSAL_ACCELERATION_ARM64
# 与 REHEARSAL_ACCELERATION_X64 给出，且要求主进程已经编译过（`npm run compile`）。
#
# 仍然没有覆盖到的：台账指纹的跨版本连续性核对本身——排练把对账对象换成了这张
# 一次性证书，真证书那一次对账只在发布时发生。
set -euo pipefail

with_release_build=0
for arg in "$@"; do
  case "$arg" in
    --with-release-build) with_release_build=1 ;;
    *) echo "无法识别的参数：$arg" >&2; exit 2 ;;
  esac
done

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

# 中途失败（尤其是那段十几分钟的打包）不能把用户 keychain 搜索列表留在一个指向
# 一次性 keychain 的状态上：那台机器后面每一次 codesign 与 find-identity 都会解析
# 到不存在的东西。正常路径走到结尾时状态文件已经删掉了，这里就是空操作。
cleanup_on_failure() {
  status=$?
  if [ "$status" != '0' ] && [ -f "$state" ]; then
    node scripts/macos-release-keychain.cjs --release --state "$state" || true
  fi
  return "$status"
}
trap cleanup_on_failure EXIT

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

if [ "$with_release_build" = '1' ]; then
  # 变量名不要用 $name：那是上面那张证书的 CN，收尾断言还要用它。
  for bundle_variable in REHEARSAL_ACCELERATION_ARM64 REHEARSAL_ACCELERATION_X64; do
    if [ -z "${!bundle_variable:-}" ] || [ ! -d "${!bundle_variable}" ]; then
      echo "排练失败：$bundle_variable 必须指向已准备好的加速资源目录。" >&2
      exit 1
    fi
  done
  version=$(node -p 'require("./package.json").version')
  output="release-free-$version"
  rm -rf "$output"
  # 与 publish-release.yml 的 macos-build 同一条命令，只多了 --rehearsal-identity：
  # 台账对账的对象换成这张一次性证书，其余（按架构分两次构建再合并、发行名改写、
  # publishedIdentity 口径的签名预检与产物校验）一步不改。
  node scripts/run-macos-free-build.cjs \
    --rehearsal-identity "$sha256" \
    --acceleration-arm64 "$REHEARSAL_ACCELERATION_ARM64" \
    --acceleration-x64 "$REHEARSAL_ACCELERATION_X64"
  # 每一项产物校验都绿、装上去却被 dyld 当场杀掉——2026-09-19 就是这样，
  # 只有真的把它启动起来才看得见。
  node e2e/macos-launch-smoke.mjs "$output"
  rm -rf "$output"
fi

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
if [ "$with_release_build" = '1' ]; then
  echo 'macOS 发布路径排练通过：导入、签名、出包、产物校验、启动、撤销、还原全走通'
else
  echo 'macOS 发布签名身份排练通过：导入、签名、撤销、还原四步都对'
fi
