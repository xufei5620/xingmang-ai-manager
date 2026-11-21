// 主窗口 xingmang:// 回的每个文件都带上安全策略响应头（#1406 P3-2）。index.html 里那份 <meta> 只管得到页面
// 本身：后台线程（视频剪辑拼片的 compose-worker）只认自己那个脚本回包里的头，不继承页面的 <meta>，以前在里面
// 想连哪个站都行。头和 <meta> 一字不差，页面本身能做的事不变（两份同时生效，取交集），由测试钉住。
//
// 只能在协议回包里带：webRequest.onHeadersReceived 注入的头，Electron 只给页面用、到不了后台线程
// （2026-10-27 在 Electron 43.8.3 上实测：协议回包带头，页面和线程里连外站都被拦；改用 webRequest 注入，只有页面被拦）。
export const applicationContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: xingmang-asset:",
  // 页内看片（yoyo 2026-11-09 亲手回「看片放开」）：只放 xingmang-asset:，那个协议只回作品库里当前账号的音视频
  // （ai-asset-protocol.ts）。不带 'self'、blob:、data: 和任何外站，范围不许再扩大。
  "media-src xingmang-asset:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function applicationSecurityResponseHeaders(): Record<string, string[]> {
  return { 'Content-Security-Policy': [applicationContentSecurityPolicy] }
}

// 窗口没响应时主进程要问出界面卡在哪段代码（main.ts reportRendererHang 调 collectJavaScriptCallStack）。Chromium
// 只替带了这个 Document-Policy 的页面取栈，而且这项功能要先用 --enable-features 打开（main.ts 在 ready 之前开）。
// 它只决定 Chromium 能不能替我们取页面的调用栈，页面自己多不了任何本事。
export const rendererCallStackDocumentPolicy = 'include-js-call-stacks-in-crash-reports'
export const rendererCallStackFeature = 'DocumentPolicyIncludeJSCallStacksInCrashReports'

export function applicationResponseHeaders(): Record<string, string[]> {
  return { ...applicationSecurityResponseHeaders(), 'Document-Policy': [rendererCallStackDocumentPolicy] }
}
