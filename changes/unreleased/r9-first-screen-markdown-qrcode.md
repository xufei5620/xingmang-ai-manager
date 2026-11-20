## 开发

- 0.2.25 总单第 77 项 R9（0.2.24 深查「性能和资源」第三节）：公告、用户协议和隐私政策的 Markdown 排版（react-markdown 连带 remark / micromark
  约 150KB）和客服二维码库（qrcode 约 26KB）原来静态打进首屏包，每次开机都要多解析一遍。现在 `src/renderer-v2/markdown-view.tsx`
  打开那个框时才 `import()` 读 `markdown-renderer.tsx`（框一开就跟读内容并着读，读不进来退成原文照排，不让整个界面掉进出错页），
  `features/app/useSupportContact.ts` 首屏画完再 `import('qrcode')`（欢迎页要马上显示那张二维码，所以不等点开）。
- 实测（main `3b81bb4` 上，同条件生产构建，入口加预加载的 JS）：首屏 1,195,542 → 1,018,654 字节，少 14.8%（gzip 392,505 → 337,557）。Linux 云端沙箱编译版、
  已登录假账号站，改前改后交替各 12 轮中位数（从页面开始加载算）：首页出来冷启动 455→432ms、热启动 470→426ms；
  `first-contentful-paint` 冷启动 306→270ms。Windows 慢机没量过。
- 用例：`markdown-view.test.tsx`（读进来前只画占位、读进来后跟原来直接用 react-markdown 的输出逐字一样、读不进来退成原文）；
  `first-screen-imports.test.ts` 钉住 react-markdown、remark-gfm、qrcode 只能由按需加载的那几块静态引，旧代码上红；
  `Announcement.test.tsx` 两条 Markdown 安全用例改成等排版读进来再取 HTML，断言一条没动。
