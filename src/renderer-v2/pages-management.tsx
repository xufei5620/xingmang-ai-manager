// 记录页在自己的文件里（#1070 第 11 步，原样搬出）：features/sessions/SessionsPage.tsx，记录页和「插件」页共用的工具选单
// 在 features/tools/provider-options.ts。这里只转出，原来从这里 import 的地方不用改。
// 原来这里还转出外接工具、技能、插件三页和它们共用的那一份；0.2.25 合成一页「插件」（features/extensions/PluginsHub.tsx）
// 以后旧页删了，共用的那一份直接从 features/extensions/extensions-common.tsx 拿。
export { SessionsPage, sessionRowMeta, sessionToolCounts } from './features/sessions/SessionsPage'
