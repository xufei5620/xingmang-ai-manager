# 人工验收脚本（scripts/manual-acceptance/）

`scripts/manual-acceptance/` 里的脚本**不能进 CI**：它们各自需要 CI runner 给不出的东西——
真实账号口令、本地的真实附件、或者一台已经装好产物的 Windows 机器。
它们原先混在 `e2e/` 里，看起来像自动化测试但从没有人跑（审查总表 T-G5、T-B4）。

全部脚本都在仓库根目录执行。

## `managed-bootstrap-smoke.mjs`

验证"登录后自动签发托管 CLI 密钥并写进 CLI 配置"这条链路在真实账号上成立。

- **仅 Windows**，非 Windows 直接抛错退出。
- 需要先 `npm run compile`（脚本启动的是已编译产物）。
- 需要**真实账号**，二选一：
  - `XINGMANG_E2E_SESSION_SOURCE`：一个已登录过的 userData 目录，里面要有 `account-session.dat`
    与 `managed-cli-keys.dat`（`settings.json` 可选）。脚本把它们复制到临时 userData，不动源目录。
  - `XINGMANG_E2E_USERNAME` + `XINGMANG_E2E_PASSWORD`：脚本自己走一次登录。
- **会对 `xm.solov.cc` 发真实请求**，并可能在账号下签发真实密钥。这正是它不能进 CI、
  也不能被自动化测试模仿的原因（自动化测试一律 mock，见 CLAUDE.md T12）。
- 证据写在 `artifacts/` 下，临时 userData 用 `os.tmpdir()` 里的新目录，跑完不残留在用户资料里。

## `announcement-native-visual.mjs`

验证公告的原生富文档渲染在亮/暗两套主题下的版式与外链隔离。

- 需要 `XINGMANG_ANNOUNCEMENT_FIXTURE`：**本地一份真实公告附件的绝对路径**。没有它脚本直接抛错。
  附件内容不入库，结果里也不记录个人路径。
- 需要 Chromium（沙箱里设 `XINGMANG_E2E_CHROMIUM`）。
- 页面夹具仍在 `e2e/announcement-native-visual-fixture.html` / `.tsx`，由脚本起的 Vite server 提供。
- 结果与问题清单写在 `artifacts/renderer-v2-announcement-native/`，有问题时以非零退出。

## `canvas-window-smoke.mjs`

驱动真实编译产物，确认导航里的「无限画布」确实打开隔离的画布 BrowserWindow 且画布能渲染。

- 需要先 `npm run compile`，并且 `dist-canvas/` 里已有画布产物（`npm run canvas:prepare`）。
- ⚠️ **当前跑不通**：脚本等的还是 legacy 的 `.app-shell` / `.main-nav` 选择器，
  而 `npm run compile` 默认产出 renderer-v2。要用它得先把选择器换成 renderer-v2 的 testid。
  画布目前处于冻结期（只修安全问题），所以这里只搬家、不改它的功能断言。
- 只碰 `artifacts/` 下的影子 HOME 与 userData，不碰真实用户资料。
