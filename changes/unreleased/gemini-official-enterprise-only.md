## 用户

- Gemini CLI 的登录来源里，「Google 账号」改名为「Google 企业版账号」，并在选项旁边写明：个人 Google 账号（含 AI Pro / Ultra 订阅）自 2026 年 6 月起已不能用于 Gemini CLI，个人用户请用星芒账号或自己填写密钥。选项本身保留，企业版 Code Assist 账号照常可用。

## 开发

- `src/renderer-v2/registry/tools.ts` 新增 `officialAccountNotes`（`Record<ProviderId, string | null>`，漏键是编译错），给官方来源挂一句按工具走的限制说明；`gemini` 的 `officialAccountNames` 改为「Google 企业版账号」。依据 google-gemini/gemini-cli discussion #27274：Google 自 2026-06-18 起不再服务个人账号，Gemini CLI 只剩企业版 Code Assist 与 API Key 两条路。
- 配置对话框在来源分段器下方直接渲染这句说明（`tool-source-note`），确认连接这一步在来源仍是官方时也带上（`guide-official-note`）。只改文案，官方来源的选择与保存逻辑不动；新装的 Gemini 默认来源仍是星芒账号（`sourceFor` 的 `missing` 回落到 `account`），浏览器用例钉住了这一点。
