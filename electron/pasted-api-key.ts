// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports nothing on purpose: the renderer value-imports this file (registered in
// scripts/verify-renderer-boundary.test.cjs), so it must stay free of Node APIs (I6).

// 客户自己粘贴的密钥（深查 J7）：页面查格式、主进程检测模型和保存配置都先过这一遍，
// 两边去掉的是同一批字符，页面放行的那串就是主进程拿去用的那串。
//
// - 从 PDF、Word、邮件里复制、被折成两行的密钥，粘进单行框时 Chromium 把中间的换行换成空格
//   （sk-abc def），以前格式检查放行、存进工具后服务端回 401。
// - 飞书文档、网页、公众号文章复制出来常在头、尾或中间夹着零宽空格，trim() 去不掉：在开头时
//   星芒密钥的格式检查说「应以 sk- 开头」，在别处时检测模型组请求头直接抛英文 ByteString 报错。
//
// 密钥本来就不会有这些字符，去掉不会把能用的密钥改坏。Tab、换行这类控制字符不在这一批里：
// 夹在中间的照旧由主进程整串拒掉（fetchAvailableModels、parseExternalClientConfigRequest 的控制字符检查），
// 这里不替它放宽。
const pastedInvisibleCharacters = /[ \u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/g

/** 去掉空格、不换行空格、全角空格这类空白和零宽字符，再去掉首尾空白。 */
export function normalizePastedApiKey(value: string): string {
  return value.replace(pastedInvisibleCharacters, '').trim()
}
