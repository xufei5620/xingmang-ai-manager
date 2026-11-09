## 用户

- Mac 上星芒装、更新的 OpenCode 重新跟上 OpenCode 的新版：OpenCode 10 月 28 日发的 1.19.5 换了放版本信息的方式，
  星芒一直停在 1.19.4；星芒自己的下载点一时不通、改去 OpenCode 官方下载时，还会报「没下载下来」或「没更新成」。

## 开发

- OpenCode 1.19.5（2026-10-28）起不再往 GitHub Release 放 Tauri 的 `latest.json`（它们 `script/publish.ts` 写明那份
  只给旧版 Tauri 自动更新用、要的签名密钥已停用），桌面端早已换成 Electron，版本信息是 electron-updater 的
  `latest-mac.yml`。`releases/latest/download/latest.json` 照样跳到 `v1.19.5/latest.json`、再回 404。
- `scripts/sync-opencode-cos.cjs` 从那天起每次都卡在 `source-feed`（`source-url-rejected`，#1519 连续 32 次），桶停在 1.19.4。
  现在改问 `latest-mac.yml`：只读顶格那一行 `version`，并要求它列着两种芯片的 `opencode-desktop-mac-<arm64|x64>.zip`；
  下的仍是同一版的 `.app.tar.gz`，桶清单格式不变，已经发出去的客户端照常从桶里拿到新版。桶里旧清单的
  `source.feedUrl`（旧地址）照样认。签名、Team ID、Gatekeeper、版本一致这几道核对都没动。
- `electron/macos-desktop-app-installer.ts`：Mac 上 OpenCode 问官方那一路（桶没走通时的兜底、桶太慢时的测速）同样改读
  `latest-mac.yml`（新增 `feedFormat: 'yaml'`，原文交给 `selectOpenCodeRelease`），包地址照旧按版本号自己拼，跳转白名单不变。
