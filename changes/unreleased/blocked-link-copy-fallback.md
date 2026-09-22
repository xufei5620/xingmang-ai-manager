## 用户

- 公告和用户协议、隐私政策里有些链接不能在软件里直接打开。以前点了只提示「不允许打开该链接」，现在会自动把这个链接复制好，并提示你打开浏览器粘贴到地址栏就能看到；链接地址也会显示出来，复制没成功时可以自己选中复制。

## 开发

- 第十批候选 8。外链名单的逐字全等规则（I12）不动，也不做「同站放行」；只补拦下之后的出路。
- 新增零依赖模块 `electron/external-url-blocked.ts`：`external:open` 拒绝时改抛 `ExternalUrlBlockedError`，文案仍是「不允许打开该链接」。Electron 只把 `error.toString()`（`${name}: ${message}`）送过 IPC，其它属性全丢，所以错误名就是那个稳定的错误码；`isExternalUrlBlockedError` 同时认进程内的实例和过桥后带通道前缀的形状，不比对中文文案。不新增 IPC 通道、不改契约。
- 渲染层 `src/renderer-v2/external-link-fallback.tsx` 的 `openExternalOrCopy`：只有认出这个错误码、且链接是不带账号密码段的 http / https 时才复制（写剪贴板沿用 `navigator.clipboard.writeText`）并返回提示；其它协议照旧拦下、不复制，其它失败原样抛给调用方。剪贴板被拒时仍把地址摆出来。
- 接入两处：`features/shell/Announcement.tsx`（`AnnouncementCenter` 把包装后的 `openLink` 传给正文，Markdown、富文本与原生公告框三种渲染都走它）与 `features/auth/LegalDocument.tsx`（提示显示在正文上方，不再把整篇协议换成错误）。
- 测试：`external-url-blocked.test.ts`、`external-link-fallback.test.tsx`、`ipc.test.ts` 钉住过桥后的形状；`testing/app-check.mjs` 在浏览器里点公告链接，验证复制成功与剪贴板被拒两种提示。
- legacy 树未改，但主进程共用同一条通道：legacy 界面里被拦的链接报错前缀会从 `Error:` 变成 `ExternalUrlBlockedError:`，句子本身不变。
