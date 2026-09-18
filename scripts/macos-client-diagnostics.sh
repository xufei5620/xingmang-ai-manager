#!/bin/bash
# Read-only diagnostics; compatible with the macOS system Bash 3.2.
# Run with: bash macos-client-diagnostics.sh ["/path/to/Codex.app" ...]
# Bash 3.2 treats some empty-array expansions as unset under nounset.
set -o pipefail

usage() {
  printf '%s\n' '用法：bash macos-client-diagnostics.sh [应用.app 的绝对路径 ...]'
  printf '%s\n' '只读取应用身份、进程和文件元数据；不启动应用、不修改配置、不读取密钥内容。'
}

if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  usage
  exit 0
fi
if [ "$(/usr/bin/uname -s)" != 'Darwin' ]; then
  printf '%s\n' '错误：此脚本只能在 macOS 上运行。' >&2
  exit 2
fi
for diag_argument in "$@"; do
  case "$diag_argument" in
    /*.app|/*.app/) ;;
    *) printf '错误：请提供 .app 的绝对路径：%s\n' "$diag_argument" >&2; usage >&2; exit 2 ;;
  esac
done

# macOS includes Perl. alarm survives exec and bounds the read-only probe itself,
# without a background watchdog that could accidentally signal a reused PID.
diag_has_timeout=0
if [ -x /usr/bin/perl ]; then diag_has_timeout=1; fi
diag_output=''
diag_status=0
capture_probe() {
  local diag_seconds="$1"
  shift
  if [ "$diag_has_timeout" -eq 1 ]; then
    diag_output=$(/usr/bin/perl -e 'alarm shift @ARGV; exec {$ARGV[0]} @ARGV; die "exec failed: $!\n";' "$diag_seconds" "$@" 2>&1)
    diag_status=$?
  else
    diag_output=$("$@" 2>&1)
    diag_status=$?
  fi
}

print_probe() {
  if [ "$diag_status" -eq 0 ]; then
    printf 'status=ok\n'
  elif [ "$diag_status" -eq 142 ]; then
    printf 'status=incomplete (timeout/SIGALRM), exit=%s\n' "$diag_status"
  else
    printf 'status=failed, exit=%s\n' "$diag_status"
  fi
  if [ -n "$diag_output" ]; then printf '%s\n' "$diag_output"; fi
}

report_probe() {
  local diag_label="$1"
  shift
  printf '\n[%s]\n' "$diag_label"
  capture_probe "$@"
  print_probe
}

diag_candidates=()
diag_sources=()
add_candidate() {
  local diag_path="${1%/}" diag_source="$2" diag_index diag_canonical
  case "$diag_path" in
    /*.app) ;;
    *) printf 'candidate_rejected=%s (不是 .app 绝对路径)\n' "$diag_path"; return ;;
  esac
  if [ -d "$diag_path" ]; then
    diag_canonical=$(cd -P -- "$diag_path" && /bin/pwd -P)
    if [ "$?" -eq 0 ]; then
      diag_path="$diag_canonical"
    else
      printf 'candidate_canonicalization_failed=%s\n' "$diag_path"
    fi
  fi
  for ((diag_index=0; diag_index<${#diag_candidates[@]}; diag_index++)); do
    if [ "${diag_candidates[$diag_index]}" = "$diag_path" ]; then
      diag_sources[$diag_index]="${diag_sources[$diag_index]}, $diag_source"
      return
    fi
  done
  if [ "${#diag_candidates[@]}" -ge 64 ]; then
    printf 'candidate_limit_reached=64; omitted=%s\n' "$diag_path"
    return
  fi
  diag_candidates[${#diag_candidates[@]}]="$diag_path"
  diag_sources[${#diag_sources[@]}]="$diag_source"
}

printf '%s\n' '星芒 / Codex macOS 只读诊断 v1'
printf 'timestamp=%s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'probe_timeout=%s (1=enabled)\n' "$diag_has_timeout"
if [ "$diag_has_timeout" -eq 0 ]; then
  printf '%s\n' '提示：系统 Perl 不可用，探测没有超时保护；长时间无输出时可按 Ctrl-C。'
fi
report_probe 'macOS' 5 /usr/bin/sw_vers
report_probe '当前命令架构' 5 /usr/bin/uname -m
report_probe '硬件 arm64 支持（1=Apple Silicon）' 5 /usr/sbin/sysctl -n hw.optional.arm64
report_probe '当前进程 Rosetta（1=转译；Intel 上键不存在也会显示原始错误）' 5 /usr/sbin/sysctl -n sysctl.proc_translated
report_probe '开发者工具路径（只检测；不存在时跳过 lipo，避免安装提示）' 5 /usr/bin/xcode-select -p
diag_has_developer_tools=0
if [ "$diag_status" -eq 0 ] && [ -d "$diag_output" ]; then diag_has_developer_tools=1; fi

for diag_path in /Applications/Codex.app /Applications/ChatGPT.app "$HOME/Applications/Codex.app" "$HOME/Applications/ChatGPT.app"; do
  add_candidate "$diag_path" standard
done
for diag_path in "$@"; do add_candidate "$diag_path" explicit; done

printf '\n[运行中的目标应用：NSWorkspace]\n'
capture_probe 10 /usr/bin/osascript -l JavaScript - "$@" <<'JXA_RUNNING'
ObjC.import('AppKit');
function text(value) { return String(ObjC.unwrap(value) || ''); }
function urlPath(value) { return value && !value.isNil() ? text(value.path) : ''; }
function clean(value) { return String(value).replace(/[\t\r\n]/g, ' '); }
function run(argv) {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var rows = [];
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var identifier = text(app.bundleIdentifier);
    var name = text(app.localizedName);
    var bundle = urlPath(app.bundleURL);
    var executable = urlPath(app.executableURL);
    var selected = argv.some(function (path) { return path.replace(/\/$/, '') === bundle; });
    if (!selected && !/^(com\.openai\.codex|com\.xingmang\.ai\.manager)(\.|$)/i.test(identifier)
        && !/星芒|xingmang|codex/i.test(name + ' ' + bundle)) continue;
    rows.push([app.processIdentifier, identifier || '(none)', app.activationPolicy,
      bundle || '(none)', executable || '(none)', name || '(none)'].map(clean).join('\t'));
  }
  return rows.join('\n');
}
JXA_RUNNING
diag_running_status="$diag_status"
diag_running_output="$diag_output"
printf 'PID\tBundle ID\tActivation policy\tBundle path\tExecutable path\tName\n'
print_probe
printf '%s\n' 'Activation policy: 0=regular（Dock），1=accessory，2=prohibited（后台）。'
if [ "$diag_running_status" -eq 0 ] && [ -n "$diag_running_output" ]; then
  while IFS=$'\t' read -r diag_pid diag_identifier diag_policy diag_bundle diag_executable diag_name; do
    case "$diag_bundle" in
      *.app/Contents/*) add_candidate "${diag_bundle%%.app/Contents/*}.app" running ;;
      /*.app) add_candidate "$diag_bundle" running ;;
    esac
  done <<< "$diag_running_output"
elif [ "$diag_running_status" -eq 0 ]; then
  printf '%s\n' '(未发现运行中的目标应用)'
fi

printf '\n[目标进程：只读取 comm，不读取 args 或环境变量]\n'
capture_probe 5 /bin/ps -ww -axo pid=,ppid=,comm=
if [ "$diag_status" -ne 0 ]; then
  print_probe
else
  diag_process_matches=0
  while read -r diag_pid diag_ppid diag_executable; do
    diag_match=0
    case "$diag_executable" in
      *星芒*|*[Xx][Ii][Nn][Gg][Mm][Aa][Nn][Gg]*|*[Cc][Oo][Dd][Ee][Xx]*) diag_match=1 ;;
    esac
    for diag_path in "${diag_candidates[@]}"; do
      case "$diag_executable" in "$diag_path"/Contents/*) diag_match=1 ;; esac
    done
    if [ "$diag_match" -eq 1 ]; then
      printf 'PID=%s PPID=%s executable=%s\n' "$diag_pid" "$diag_ppid" "$diag_executable"
      diag_process_matches=$((diag_process_matches + 1))
    fi
  done <<< "$diag_output"
  printf 'matched_processes=%s\n' "$diag_process_matches"
fi

printf '\n[Dock 固定项与最近项：只输出目标应用]\n'
capture_probe 10 /usr/bin/osascript -l JavaScript - <<'JXA_DOCK'
ObjC.import('Foundation');
function run() {
  var domain = ObjC.deepUnwrap($.NSUserDefaults.standardUserDefaults.persistentDomainForName('com.apple.dock'));
  if (!domain) throw new Error('Dock domain unavailable');
  var matches = [];
  ['persistent-apps', 'recent-apps'].forEach(function (section) {
    (domain[section] || []).forEach(function (tile) {
      var data = tile['tile-data'] || {};
      var row = {section: section, label: data['file-label'] || '',
        bundleIdentifier: data['bundle-identifier'] || '',
        url: (data['file-data'] || {})['_CFURLString'] || ''};
      if (/星芒|xingmang|codex/i.test(JSON.stringify(row))) matches.push(row);
    });
  });
  return JSON.stringify(matches, null, 2);
}
JXA_DOCK
print_probe

printf '\n[Spotlight Codex 候选]\n'
capture_probe 10 /usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"'
diag_spotlight_status="$diag_status"
diag_spotlight_output="$diag_output"
print_probe
if [ "$diag_spotlight_status" -eq 0 ]; then
  if [ -z "$diag_spotlight_output" ]; then printf '%s\n' 'spotlight=empty（仅表示未索引到，不证明未安装）'; fi
  while IFS= read -r diag_path; do
    if [ -n "$diag_path" ]; then add_candidate "$diag_path" spotlight; fi
  done <<< "$diag_spotlight_output"
fi

diag_verified_count=0
diag_bundle_id=''
diag_executable_name=''
diag_requirement='identifier "com.openai.codex" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "2DC432GLL2"'
for ((diag_index=0; diag_index<${#diag_candidates[@]}; diag_index++)); do
  diag_path="${diag_candidates[$diag_index]}"
  printf '\n[应用候选 %s]\npath=%s\nsource=%s\n' "$((diag_index + 1))" "$diag_path" "${diag_sources[$diag_index]}"
  if [ ! -d "$diag_path" ]; then
    printf '%s\n' 'bundle=missing_or_inaccessible'
    continue
  fi
  diag_info="$diag_path/Contents/Info.plist"
  report_probe 'Info.plist 格式' 5 /usr/bin/plutil -lint "$diag_info"
  if [ "$diag_status" -ne 0 ]; then continue; fi
  diag_bundle_id=''
  diag_executable_name=''
  for diag_property in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion CFBundleExecutable LSUIElement LSBackgroundOnly; do
    printf '\n%s: ' "$diag_property"
    capture_probe 5 /usr/bin/plutil -extract "$diag_property" raw -o - "$diag_info"
    print_probe
    if [ "$diag_status" -eq 0 ]; then
      case "$diag_property" in
        CFBundleIdentifier) diag_bundle_id="$diag_output" ;;
        CFBundleExecutable) diag_executable_name="$diag_output" ;;
      esac
    fi
  done
  case "$diag_executable_name" in
    ''|.|..|*/*|*$'\n'*|*$'\r'*) printf '%s\n' 'executable=invalid_or_unreadable_name' ;;
    *)
      diag_executable="$diag_path/Contents/MacOS/$diag_executable_name"
      printf 'executable_path=%s\n' "$diag_executable"
      if [ -f "$diag_executable" ] && [ -x "$diag_executable" ]; then
        printf '%s\n' 'executable_file=yes'
        if [ "$diag_has_developer_tools" -eq 1 ]; then
          report_probe 'Mach-O 架构（只读取，不运行）' 10 /usr/bin/lipo -archs "$diag_executable"
        else
          printf '%s\n' '开发者工具不可用，使用系统 file 提供架构提示。'
          report_probe 'Mach-O 文件类型与架构提示（只读取，不运行）' 10 /usr/bin/file -b "$diag_executable"
        fi
      else
        printf '%s\n' 'executable_file=missing_or_not_executable'
      fi
      ;;
  esac
  report_probe '签名元数据（仅供识别，不作为验证结论）' 10 /usr/bin/codesign -dv --verbose=2 "$diag_path"
  if [ "$diag_bundle_id" = 'com.openai.codex' ]; then
    report_probe 'Codex OpenAI Developer ID requirement 与完整性验证' 30 /usr/bin/codesign --verify --strict --deep "-R=$diag_requirement" "$diag_path"
    if [ "$diag_status" -eq 0 ]; then
      diag_verified_count=$((diag_verified_count + 1))
      printf '%s\n' 'codex_signature=verified'
      if [[ "${diag_sources[$diag_index]}" != *spotlight* ]]; then
        if [ "$diag_spotlight_status" -eq 0 ]; then
          printf '%s\n' 'spotlight_membership=not_returned（已找到应用，但本次索引没有返回此副本）'
        else
          printf '%s\n' 'spotlight_membership=unknown（索引探测未完成）'
        fi
      fi
    elif [ "$diag_status" -eq 142 ]; then
      printf '%s\n' 'codex_signature=incomplete（超时；不能据此认定签名无效）'
    else
      printf 'codex_signature=not_verified (exit=%s；请结合上方原始错误区分拒绝与工具故障)\n' "$diag_status"
    fi
  else
    printf 'codex_bundle_identity=no (actual=%s)\n' "${diag_bundle_id:-(unreadable)}"
    case "$diag_bundle_id" in
      com.xingmang.ai.manager*) report_probe '星芒签名完整性（不验证发行者身份）' 30 /usr/bin/codesign --verify --strict --deep "$diag_path" ;;
    esac
  fi
done

file_metadata() {
  local diag_file="$1" diag_readable=no
  printf 'path=%s\n' "$diag_file"
  if [ ! -e "$diag_file" ]; then
    if [ -L "$diag_file" ]; then
      printf '%s\n' 'exists=broken_symlink_or_inaccessible'
    else
      printf '%s\n' 'exists=no_or_inaccessible'
    fi
    return
  fi
  if [ -r "$diag_file" ]; then diag_readable=yes; fi
  printf 'exists=yes readable=%s\n' "$diag_readable"
  capture_probe 5 /usr/bin/stat -L -f 'bytes=%z type=%HT' "$diag_file"
  print_probe
}

printf '\n[Codex 配置：只检查存在性、可读性、字节数，不读取内容]\n'
file_metadata "$HOME/.codex/config.toml"
file_metadata "$HOME/.codex/auth.json"
if [ -n "${CODEX_HOME:-}" ] && [ "${CODEX_HOME%/}" != "$HOME/.codex" ]; then
  printf '%s\n' '另检查此终端指定的 CODEX_HOME；这不证明已运行应用使用同一目录。'
  file_metadata "${CODEX_HOME%/}/config.toml"
  file_metadata "${CODEX_HOME%/}/auth.json"
fi

printf '\nverified_codex_copies=%s\n' "$diag_verified_count"
if [ "$diag_verified_count" -gt 1 ]; then
  printf '%s\n' '发现多个通过签名验证的 Codex 副本；请对照运行路径与 Dock 路径。'
fi
printf '%s\n' '诊断采集结束；各项 status 才是该项结果，脚本结束不表示所有检查通过。'
