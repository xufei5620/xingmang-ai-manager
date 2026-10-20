## 开发

- `dl-landing/app.js` 的 `DOWNLOAD_GUIDE_URL` 从飞书安装教程换成教程站下载区
  `https://docs-new.solov.cc/guide/manager#download-installers`，和应用里「打开下载页」（`electron/app-download-page.ts`）
  同一个地址；那边按 Windows、Apple 芯片、Intel 芯片分开给包（Refs #1155 第 1 条）。`index.html` 里 `app.js` 的缓存标识跟着换。
  `scripts/dl-landing-install-guide.test.cjs` 钉住两边地址一致、落地页不再出现飞书链接。仓库里只改源文件，
  dl.solov.cc 上的页面要把 `dl-landing/` 的 `index.html`、`app.js` 照 `docs/DL-LANDING-PLAN.md` 第 4 节传到站点根目录才更新：
  `npm run dl:publish` 只传安装包和 `latest.json`，不传页面文件。
- `docs/LINUX.md`、`docs/DL-LANDING-PLAN.md` 里说落地页按钮去哪的几句跟着改；`docs/LINUX.md` 和 #1172 的分片原来说落地页
  靠 `dl:publish` 部署，一并改对。
