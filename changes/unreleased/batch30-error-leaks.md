## 用户

- 保存配置、重新写入 Key、新手引导、账号 Key 同步时，文件被安全软件拦住、被别的程序占着这类失败，不再把一串带半个引号的
  英文显示在屏幕上，改说现成的中文；认得出是哪一类的，上面照旧写着「工具正在运行」「写不进安装目录」这类原因。
  英文原话照旧记在运行日志里，错误框和新手引导里也还能在「给客服看的原话」里看到。
- 电脑用户名是中文时，更新没装上那句不再整句是英文，改说是哪一类问题、下一步怎么做。
- Codex 的配置文件写坏了时，在「技能」页开关技能、在「外接工具」页给 Codex 加工具，报错只说第几行附近，
  不再把出错那几行（可能带着令牌）显示出来。
- 接入其他客户端：保存后连接自检没通过时，「配置已保存」那块改用提醒色，不再是绿色；账号密钥列表没读到那句不再多一个句号。

## 开发

- 第三十批 A：新增零依赖的 `electron/chinese-sentence.ts`（`isChineseSentence`：去掉引号段和带斜杠的路径片段再看有没有汉字），
  已登记进 `scripts/verify-renderer-boundary.test.cjs`。渲染层 `business-common.tsx` 的 `speaksChinese`（第二十六批 D）改为先剥
  占位词「本地配置文件」再交给它，并导出；`errorMessage`、`StartGuide.tsx` 的 `guideStepFailure`、`key-sync-failure.ts` 的
  `keySyncFailureReason` 三处原来的「有没有汉字」都换成它。以前占位词本身是汉字，带路径的英文原话（EPERM/EACCES/EBUSY/ENOENT
  加 `open 'C:\…'`）全被当成中文原样上屏；改后和不带路径的英文一样落到各自现成的中文兜底句，没有新加文案。
- 页头红条保住归类：`business-common.tsx` 新增 `failureWithDetail`（`operationFailureFrom` 改为调它），`useOperation` 落到兜底句时
  把原话（`supportDetailOf`：脱路径、打码、160 字）记成 `detail`；`ResultNotice` 收可选 `detail`，改用错误框同一个认法
  `presentOperationFailure`，原话只拿来认类别、不上屏。`{...operation}` 展开的页面自动带上；直接写 `error={operation.error}`
  的 19 处和与 `resource.error` 等拼起来的 4 处（拼起来的只在显示的正是这次操作的报错时才给），以及 Mac 卸载框都补传了 `detail`。
  顺带：不带路径、但认得出类别的英文（例如 ENOSPC），页头红条现在也有标题，和错误框一个说法。
- 第三十批 B：`electron/codex-extensions.ts` 的 `parseTomlFile` 解析失败时只报「（第 N 行附近）」，不再把 @iarna/toml 的原话
  （会抄出出错那行上下几行，客户自己加的外接工具令牌常在旁边）拼进报错；读文件自己的失败（超上限、读的时候被换掉、被拒绝）
  挪到 try 外照原样抛。`tomlErrorLocation` 从 `config-files.ts` 挪到新的 `electron/toml-error-location.ts`，两边共用。
  `errorMessage` 和 `keySyncFailureReason` 原样放行中文原话时也过一遍 `redactSecretPatterns`（新手引导和「给客服看的原话」早就打码）。
- 第三十批 D：新增 `features/tools/external-client-notice.ts`：`externalClientSavedTone` 让「配置已保存」那块在自检结论为
  warn/bad 时用 `warn`，通过、未配置、这次没测成照旧 `ok`，字不改；`accountKeyListFailureText` 拼句前去掉原因结尾的句号。
- 第三十批跟进项：`electron/updater.ts` 的 `describeUnrecognizedUpdateFailure` 判中文改用 `isChineseSentence`。以前判的是没脱路径
  的原话，Windows 中文用户名（或 Mac 上路径里的「星芒AI管理工具」）让英文原话整句交给界面，更新页、首页气泡、「必须更新」那道门
  脱敏后显示成「…, open '本地配置文件」。原话照旧进 `detail` 和运行日志。
