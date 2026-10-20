## 开发

- Intel Mac 的「关于本机」没有「芯片」那一行，写的是「处理器」，原来的说法会让 Intel 用户以为自己该选 M 系列芯片版
  （#1155 第 2 条，yoyo 10-18 批）。三处「芯片」改「处理器」：下载落地页选包说明改成「有“芯片 Apple M…”一行就选
  M 系列芯片版，有“处理器 …Intel…”一行就选 Intel 版」（`dl-landing/index.html`），落地页 Intel 按钮小字
  「Intel 处理器」（`dl-landing/app.js`），软件检查页「操作系统」一项在 Intel Mac 上写「macOS 13（Intel 处理器）」
  （`electron/diagnostics.ts`）。落地页要把 `dl-landing/` 的页面文件照 `docs/DL-LANDING-PLAN.md` 第 4 节传到站点根目录后
  才对客户生效（`npm run dl:publish` 只传安装包和 `latest.json`）。
