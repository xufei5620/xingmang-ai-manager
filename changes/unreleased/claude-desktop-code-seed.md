## 开发

- Windows 上从星芒点「打开」Claude Desktop 之前，先替它把聊天要用的 Claude Code 程序放好
  （`electron/claude-desktop-code-seed.ts`）。Claude Desktop 把要用的 Claude Code 版本和
  `.zst` 校验值编在自己的 `app.asar` 里，启动时只认 `Claude-3p\claude-code\<版本>\<校验值前12位>\claude.exe`
  在、旁边的 `.verified` 等于校验值；以前它只能自己从 Claude 官网下，加速下线后国内下不动。
  现在只读解析 `app.asar`（Chromium Pickle 头 + `.vite/build/*.js`，有界读、总扫描 96MB 封顶）拿到版本，
  从国内 npm 镜像下 `@anthropic-ai/claude-code-win32-<arch>` 同一版本的包，按 npm 官方源的
  `dist.integrity`（SHA-512）对账，流式解 gzip + 自写 tar 解析（pax、GNU 长名、校验和、解压上限）
  取出 `package/claude.exe`，临时名写入、改名就位，最后写 `.verified`。镜像对不上换官方源；
  都不行、读不到版本、磁盘不够 1GB、超过 15 分钟、Claude Desktop 正开着或中途被打开，一律跳过、照常打开，只记日志。
- 只在同用户执行模式下做（`trusted-only` 跳过），挂在 `external-client-runtime.ts` 的 `launch` 里、
  跟「打开」同一把锁（I11 已登记例外，范围没扩）；下载地址只放行 `registry.npmmirror.com`、
  `cdn.npmmirror.com`、`registry.npmjs.org` 上这个包这一版的固定路径（I10），写盘走 `safe-local-data`（I8），
  日志路径过 `redactHomeDirectory`（I13）。远程开关 `featuresOff` 加了 `claude-desktop-code-seed`，能单独关掉。
