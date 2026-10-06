## 用户

- Windows 上以管理员身份运行星芒时卸载工具，弹出的那个命令窗口改说中文：标题「星芒：卸载 Claude Code」，
  卸完说「卸载完成。现在可以关掉这个窗口，回星芒点「重新检测」。」，没卸成说清错误代码、下一步怎么办。
  中间卸载程序自己吐的几行还是英文。

## 开发

- 已知33：`windows-elevation.ts` 抽出纯函数 `buildUnelevatedCommandScript`，.cmd 改按 UTF-8（不带 BOM）写，
  第二行用固定解析出来的 `System32\chcp.com` 把窗口代码页换成 65001，之后的中文行按 UTF-8 解；说明文字拒绝
  引号、百分号、&|<>^、半角括号、换行，命令行照旧只许 ASCII。`UnelevatedCommandWindowRequest` 的 `title`
  换成 `text`（标题、开头、成功、失败四句）。要在 Windows 真机上看中文不乱码，看不对就退回英文那版。
