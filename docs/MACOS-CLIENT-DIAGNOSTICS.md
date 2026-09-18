# macOS 客户端只读诊断

此脚本用于排查星芒 Dock 出现两个图标、Codex 已安装却未被识别，以及应用副本、架构或签名不匹配。脚本不启动或退出应用，不安装软件，不使用 `sudo`，不修改 Dock、Spotlight、配置、系统代理或钥匙串。

## 运行方法

将仓库中的 [macos-client-diagnostics.sh](../scripts/macos-client-diagnostics.sh) 保存到 Mac 的下载目录，打开“终端”运行：

```bash
bash "$HOME/Downloads/macos-client-diagnostics.sh" 2>&1 | tee "$HOME/Downloads/xingmang-macos-diagnostics.txt"
```

若 Codex 被改名、放在其他目录或直接从磁盘映像运行，将实际 `.app` 绝对路径作为参数。路径含空格时保留引号，也可以把应用从 Finder 拖入终端：

```bash
bash "$HOME/Downloads/macos-client-diagnostics.sh" "/Applications/Codex.app" "/Applications/星芒AI管理工具.app" 2>&1 | tee "$HOME/Downloads/xingmang-macos-diagnostics.txt"
```

脚本兼容 macOS 自带 Bash 3.2。它通过 JXA 调用 `NSWorkspace` 和 `NSUserDefaults`，不调用 System Events，不要求辅助功能或自动化控制授权。系统 Perl 可用时，普通探测最长 5–10 秒，单个应用签名验证最长 30 秒；没有 Perl 时会明确提示未启用超时，可用 `Ctrl-C` 停止。多个副本会分别验证。

星芒检测 Codex 不要求安装 Xcode 或 Command Line Tools，而是直接有界读取可执行文件的 Mach-O 头。诊断脚本中的 `lipo` 仅提供额外架构信息；开发者工具不可用时改用系统 `/usr/bin/file`，不会要求安装工具。

将生成的 `xingmang-macos-diagnostics.txt` 发回即可。报告包含本机用户名所在路径、应用安装路径、版本、PID 和签名身份；发送前可遮去用户名。脚本不输出完整进程参数、不读取进程环境，不读取 `config.toml`、`auth.json` 的内容，不读取 Key 或登录凭据。上面的 `tee` 只负责保存这份报告。

## 无需下载脚本的简短检查

也可以先把下面整段复制进 Mac“终端”。如果应用在其他位置，只修改 `diag_app` 那一行。命令只读取系统、应用身份、签名和进程路径；输出中的失败信息也请一并保留。这组命令没有超时保护，长时间无输出可按 `Ctrl-C`；完整脚本还会采集 Dock、运行应用身份和索引状态。

```bash
/usr/bin/sw_vers
/usr/bin/uname -m
/usr/sbin/sysctl -n hw.optional.arm64 sysctl.proc_translated
diag_app='/Applications/Codex.app'
/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$diag_app/Contents/Info.plist"
/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$diag_app/Contents/Info.plist"
diag_executable=$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$diag_app/Contents/Info.plist")
case "$diag_executable" in
  ''|.|..|*/*) printf '%s\n' '应用可执行文件名无效或不可读' ;;
  *)
    if /usr/bin/xcode-select -p; then
      /usr/bin/lipo -archs "$diag_app/Contents/MacOS/$diag_executable"
    else
      printf '%s\n' '开发者工具不可用，使用系统 file 提供架构提示'
      /usr/bin/file -b "$diag_app/Contents/MacOS/$diag_executable"
    fi
    ;;
esac
/usr/bin/codesign --verify --strict --deep '-R=identifier "com.openai.codex" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "2DC432GLL2"' "$diag_app"
printf 'codesign_exit=%s\n' "$?"
/bin/ps -ww -axo pid=,ppid=,comm= | /usr/bin/awk '/星芒|[Xx][Ii][Nn][Gg][Mm][Aa][Nn][Gg]|[Cc][Oo][Dd][Ee][Xx]/'
```

`codesign_exit=0` 表示这次 OpenAI requirement 验证通过；其他退出码需结合错误判断。`sysctl` 在 Intel 上缺少转译键的提示也应保留。

## 报告内容

| 项目 | 用途 |
| --- | --- |
| macOS 版本、命令架构、`hw.optional.arm64`、`sysctl.proc_translated` | 区分 Intel、Apple Silicon 和当前命令是否经 Rosetta；Intel 上转译键不存在会保留原始错误 |
| 目标运行应用的 bundle ID、路径、PID、activation policy | `0` 是可显示 Dock 的普通应用；`1` 是 accessory；`2` 是禁止激活和窗口的后台应用 |
| 目标进程的 PID、PPID、`comm` 可执行路径 | 对照主进程、子进程、多个应用副本；不采集 `args` 或环境变量 |
| Dock 中匹配星芒/Codex 的固定项与最近项 | 检查 Dock 指向的路径是否与正在运行或已验证的应用相同；不输出整个 Dock plist |
| 标准安装位置、Spotlight、运行中的应用和显式路径候选 | 规范化存在的目录并合并重复路径，最多检查 64 个候选 |
| Info.plist 身份、版本、可执行文件、架构提示 | 分别识别产品、安装副本和实际二进制；不执行候选应用。仅在开发者工具可用时额外调用 `lipo`，否则使用系统 `file` |
| Codex 签名验证 | 同时验证完整性、`com.openai.codex`、Apple Developer ID 证书链和 OpenAI Team ID `2DC432GLL2` |
| Codex 配置元数据 | 仅检查默认目录和终端显式 `CODEX_HOME` 下两个文件的存在性、可读性、大小；终端环境不代表已运行应用的环境 |

## 判读边界

- `verified_codex_copies` 大于 1 表示发现多个不同实际路径的 Codex 副本通过签名验证。对照 `NSWorkspace` 的运行路径和 Dock 项路径，可以定位当前打开的是哪个副本。此计数不代表应用一定能在当前硬件运行，架构需结合 `lipo` 或 `file` 的提示和硬件结果判断。
- `spotlight=empty` 仅表示本次索引未返回目标。若标准位置、运行路径或显式路径中的 Codex 通过签名验证，但 `spotlight_membership=not_returned`，说明这个副本存在而没有被本次索引检索到。脚本不会重新索引，也不会把索引为空当作未安装。
- `codex_signature=verified` 来自 `codesign --verify` 的退出码与完整 requirement 验证，不能用前面的签名说明文字代替。`not_verified` 要结合原始错误判断签名拒绝或工具故障；`incomplete` 是超时，不能断言签名无效。
- `ChatGPT.app` 是兼容历史 Codex 文件名的候选；若 bundle ID 是普通 ChatGPT 产品而非 `com.openai.codex`，显示 `codex_bundle_identity=no` 属于正确区分。
- `LSUIElement`、`LSBackgroundOnly` 是可选字段，缺省时 `plutil` 会报告不存在。普通主应用通常没有这些字段；不应为了隐藏后台 worker 而给整个主应用设置后台属性。
- 两个匹配进程不等于两个 Dock 图标。后台 worker 可以与主界面使用同一个可执行路径；由于不读取完整启动参数，这份报告不能单凭进程表确认 worker 身份。要结合 PPID、activation policy、运行路径和出现图标的时间判断。通用 `Electron.app` 开发实例可能无法从名称识别，可显式传入它的 `.app` 路径。
- 修复后的 macOS 加速 worker 会在最早的应用 JavaScript 入口设置 `prohibited`。该入口之前还有原生启动阶段；仅凭代码和这份静态报告不能保证 Dock 在启动瞬间绝无闪现，仍需在目标 Mac 观察。

本脚本已在 Windows Git Bash 进行 Bash 语法检查；尚未在 Mac 实机运行。报告中保留各项失败的退出码和原始错误，脚本正常结束不表示所有探测通过。
