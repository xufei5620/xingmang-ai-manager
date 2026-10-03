## 开发

- CI：Electron 43 的 npm 包没有安装脚本，`npm ci` 不下二进制，要等第一个 `require('electron')` 的测试现场去下，只发一次请求、
  不重试也不限时，网络一抖那个测试就带着「Electron failed to install correctly」红掉（#319 的 Windows vitest-1 撞上 GitHub
  两次 HTTP 500，#796 的 linux-test 撞上 `fetch failed`）。现在用到二进制的作业在 `npm ci` 之后先跑
  `scripts/ci-ensure-electron-binary.cjs`：每次限时 3 分钟，失败隔 10、30、60、120 秒再试，五次都不行才报中文错误；
  重试成功也会在运行摘要里留一条警告。`quality` 里按系统、架构和 Electron 版本缓存下载包，命中时不连 GitHub（本地演练约 2 秒装好）；
  只有推送到 main 的那轮在下载后立刻写缓存，PR 不各存一份。三个出包工作流（发布、测试包、已停用的签名构建）也加了这一步，不用缓存。
  只给真用得到的作业加：Windows 只有两个 vitest 分片，其余四个分片和 Linux 浏览器作业实测不碰二进制，不多花解压时间。
  `scripts/ci-ensure-electron-binary.test.cjs` 钉住重试节奏、最坏耗时在步骤时限内，以及「哪些作业装、装在哪一步、缓存怎么配」。
