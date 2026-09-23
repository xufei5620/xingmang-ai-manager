## 用户

- 修复 Windows 用户名或所选文件夹名里带弯引号（比如 O’Brien）时，安装 Node.js、安装 Codex 桌面端、打开命令行工具会失败的问题。

## 开发

- `powerShellLiteral`（`electron/windows-elevation.ts`）原来只把 ASCII `'` 双写。PowerShell 的分词器把 U+2018~U+201B
  四种弯单引号也当单引号（`CharTraits.cs` 的 `IsSingleQuote`，`tokenizer.cs` 的 `ScanStringLiteral` 对任意两个相邻的单引号字符取后一个为字面值），
  所以路径里的 `’` 会提前闭合字面量，后半截被当成代码执行。现在五种单引号都原地双写。
  受影响的脚本：打开 CLI 的终端脚本（same-user 下以用户身份，trusted-only 下带管理员令牌）、Node.js 与 Codex 桌面端的 UAC 代理脚本
  及其提权安装脚本（经 `-Verb RunAs` 以管理员运行，same-user 下嵌入的是 `%TEMP%` 路径，含用户名）。
- `codex-desktop-service.ts` 的 `powershellLiteral` 与 `claude-native-uninstall.ts` 的 `powerShellSingleQuote` 是同样写法的副本，删掉改用 `powerShellLiteral`。
- `windows-elevation.test.ts` 新增按 PowerShell 引号规则扫描生成脚本的用例：每种弯引号、混用 ASCII 引号，以及四类生成脚本里恶意路径只作为数据出现、
  脚本结构与无害路径生成的完全一致。
