## 用户

- Gemini 的设置文件里写了注释时，接当前账号不再报「无法解析」，你写的注释也会原样留着。

## 开发

- `config-files.ts`：Gemini 的 `settings.json` 与 `trustedFolders.json` 改按 Gemini CLI 的读法解析（`strip-json-comments` 后 `JSON.parse`：认注释、不认尾逗号），带注释的文件用 `jsonc-parser` 只改变了的值、保留注释；纯 JSON 仍整份重写、行为不变。注释路径上拒绝重复键（原地改会改到一份、Gemini 读另一份）。覆盖接当前账号、切回官方、目录信任、补 AGENTS.md 四处写入与认证方式读取（全面检测 Q16）。
