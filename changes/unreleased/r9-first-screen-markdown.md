## 开发

- 0.2.25 总单第 77 项 R9（0.2.24 深查「性能和资源」第三节）：公告、用户协议和隐私政策的 Markdown 排版（react-markdown 连带 remark / micromark
  约 150KB）原来静态打进首屏包，每次开机都要多解析一遍。现在 `src/renderer-v2/markdown-view.tsx` 打开那个框时才 `import()` 读
  `markdown-renderer.tsx`（框一开就跟读内容并着读，读不进来退成原文照排，不让整个界面掉进出错页）。
- 客服二维码库（qrcode 约 26KB）也试过改成首屏画完再 `import()`，Mac 上开发版开机看见欢迎页慢了 1 秒多，`e2e/macos-dev-origin.test.mjs`
  两次越过 5 秒门槛（查根因探测 run 44880468302），改回静态引入，`useSupportContact.ts` 里写了原因。
- 实测（main `0b99e0c` 上，同条件生产构建，入口加预加载的 JS）：首屏 1,318,623 → 1,164,921 字节，少 11.7%（gzip 439,555 → 393,063）。
  Linux 云端沙箱编译版、已登录假账号站，改前改后交替各 12 轮中位数（从页面开始加载算）：冷启动首页出来 403→369ms、LCP 380→344ms；
  热启动首页 397→415ms，在噪声里（各轮 363~482 / 353~518）。Windows 慢机没量过。
- 用例：`markdown-view.test.tsx`（读进来前只画占位、读进来后跟原来直接用 react-markdown 的输出逐字一样、读不进来退成原文）；
  `first-screen-imports.test.ts` 钉住 react-markdown、remark-gfm 只能由按需加载的那几块静态引，旧代码上红；
  `Announcement.test.tsx` 两条 Markdown 安全用例改成等排版读进来再取 HTML，断言一条没动。
