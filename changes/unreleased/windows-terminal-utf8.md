## 用户

- Windows 上打开命令行 AI 工具时，终端窗口现在会切到 UTF-8：中文系统上让 AI 跑 `dir`、`git log` 这类命令时，读回的中文文件名和提交说明不再是乱码。

## 开发

- `buildCliLaunchPlan`（`electron/windows-elevation.ts`）生成的可见终端脚本在 `Set-Location` 之前设 `$OutputEncoding` / `[Console]::OutputEncoding` / `[Console]::InputEncoding` 为无 BOM 的 UTF-8，与主进程自己那二十余处探测脚本写法一致。窗口用 `-NoProfile` 启动，用户 profile 里的编码设置不会生效，此前一直沿用系统代码页（简体中文是 936）。
- 不额外跑 `chcp 65001`：.NET 的这两个 setter 本身就会调 `SetConsoleOutputCP` / `SetConsoleCP`，与 `chcp` 等价，而在可能继承提权令牌的窗口里跑 `chcp` 等于按 PATH 查找系统可执行文件（I14）。整句包在 `try { … } catch { }` 里，设不上也只是维持原状，不会让用户点「打开」后 CLI 起不来。
- 第六批候选 2。新增用例 `switches the visible terminal to UTF-8 before the CLI starts`（`electron/windows-elevation.test.ts`）钉住两条赋值、异常兜底、无 `chcp`，以及它排在 `Set-Location` 与 CLI 调用之前。
