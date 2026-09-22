## 用户

- 「检查」页的连接自检报出密钥或分组问题时，结果条上的按钮从「去处理」换成「重新写入 Key」，
  点一下就按当前账号把这个工具的 Key 重新签发并写好，写完自动再测一遍连接；写不成时直接
  显示是什么原因，不会假装已经修好。
- 安装、更新或切换账号时弹出的「Key 失效」提示里，「一键修复」按钮现在真的能用，做的是同一件事：
  按当前账号把已配置的工具重新写一次 Key。以前这颗按钮不会出现，只剩「找客服」。
- 官方账号和自己手填密钥的工具不会出现这颗按钮，避免把你自己的配置覆盖掉。

## 开发

- 第二批候选 1：把自检的密钥 / 分组层与目录里的 `keyInvalid` 都接到已有的重写路径上，
  不新做核对逻辑，也不改主进程的签发流程。旧队列项「本地 Key 与账号签发交叉核对」并入这条：
  服务端→本机的复用（`new-api-client.ts` 的 `findNewestUsableCliKeyByGroup`、
  `sub2api-relay-backend.ts` 的按名字 + 分组复用）与配置路径上的 401 自愈
  （`account-cli-provisioner.ts`）都已存在，缺的只是失效之后的下一步。
- `src/renderer-v2/features/tools/connection-check.ts`：`ConnectionCheckView` 加
  `action: 'rewrite-key' | null`，`credential` / `group` 两层在可重写时给 `action` 而不是
  `target`，并把正文换成与按钮一致的那句（主进程的 `nextStep` 仍是「到账号页看看」，
  按钮已把这件事端到面前时再让用户先跑一趟就自相矛盾）。新增 `rewritableKeyProviders()`，
  按 `sourceFor(...) === 'account'` 决定哪几个工具给得出按钮。
- `src/renderer-v2/pages-maintenance.tsx`：`BusinessActions` 加 `onRewriteKey` 与
  `rewritableKeys`；`ConnectionRowNotice` 按 `view.action` 渲染
  `health-connection-rewrite-<provider>`，重写成功才调用抽出来的 `loadConnections()` 重测，
  失败由页头的 `ResultNotice` 原样说出主进程的话。
- `src/renderer-v2/operation-error.ts`：`OperationActionId` 加 `'repair'`，`actionIds` 加
  「一键修复」。`src/renderer-v2/App.tsx`：`runAccountBootstrap` 把结论（`result` / `error`）
  回给调用方——它自己只把失败收进首页横幅，而按重写的人站在别的页面上；新增
  `rewriteAccountKeys(providers?)` 复用 `syncAfterToolInstalled` 那条同样的
  `runAccountBootstrap(userId, 'login', true, providers)`，失败原样抛出；
  `runOperationAction` 的 `repair` 分支对全部已配置工具跑同一条流程。
- 测试：`connection-check.test.ts` 钉住两层的 `action`、其余层仍跳页、来源不对时不给按钮，
  以及 `rewritableKeyProviders` 的三种来源；`operation-error.test.ts` 钉住 `keyInvalid`
  给的是 `repair` 而不是兜底的「找客服」；`testing/app-check.mjs` 三条浏览器用例分别钉住
  「密钥层点按钮 → `configureManagedCliKeys` 只带这个工具 → 自动重测变正常」、
  「重写失败 → 显示后端原话且结论不被刷掉」、「keyInvalid 的一键修复触发同一条重写」。
  夹具新增 `connectionCredential` 开关与 `window.v2Test.failMessage`。
