## 用户

- 保存配置、重新写入 Key、新手引导、账号 Key 同步时，文件被安全软件拦住、被别的程序占着这类失败，不再把一串带半个引号的
  英文显示在屏幕上，改说现成的中文；认得出是哪一类的，上面照旧写着「工具正在运行」「写不进安装目录」这类原因。
  英文原话照旧记在运行日志里，错误框和新手引导里也还能在「给客服看的原话」里看到。
- 电脑用户名是中文时，更新没装上那句不再整句是英文，改说是哪一类问题、下一步怎么做。
- 工具的配置文件写坏了（比如英文引号打成了中文引号）时，保存配置、写 Key 不再只说「无法解析，未执行修改」：
  改说哪个工具的配置文件有写错的地方（Codex、Grok CLI 还说大概在第几行）、星芒没有改动它，再告诉你去配置窗口
  最下面「高级」里点「重置为初始状态」（会先备份原来的文件）。在「技能」页开关 Codex 的技能、在「外接工具」页给 Codex 加工具时也是这句，
  不再把出错那几行（可能带着令牌）显示出来。
- 接入其他客户端：保存后连接自检没通过时，「配置已保存」那块改用提醒色，不再是绿色；账号密钥列表没读到那句不再多一个句号。

## 开发

- 第三十批 A：新增零依赖的 `electron/chinese-sentence.ts`（`isChineseSentence`：去掉引号段和路径再看有没有汉字），
  已登记进 `scripts/verify-renderer-boundary.test.cjs`。路径从第一个斜杠前的那截算起，那截里不许有汉字，遇到空白、引号、
  中文标点和括号断开，紧跟在后面、自己也带斜杠的几截（用户名带空格）算同一条路径；第二十六批 D 原来的写法会把
  「当前账号不可使用分组「GPT-中转/订阅」」这种不带空格、带斜杠的中文整句当成路径去掉。渲染层 `business-common.tsx` 的
  `speaksChinese` 改为把占位词「本地配置文件」换成一个斜杠再交给它，并导出；`errorMessage`、`StartGuide.tsx` 的
  `guideStepFailure`、`key-sync-failure.ts` 的 `keySyncFailureReason` 三处原来的「有没有汉字」都换成它。以前占位词本身是汉字，
  带路径的英文原话（EPERM/EACCES/EBUSY/ENOENT 加 `open 'C:\…'`）全被当成中文原样上屏；改后和不带路径的英文一样落到各自
  现成的中文兜底句，没有新加文案。
- 页头红条保住归类：`business-common.tsx` 新增 `failureWithDetail`（`operationFailureFrom` 改为调它），`useOperation` 和
  `useResource` 落到兜底句时把原话（`supportDetailOf`：脱路径、打码、160 字）记成 `detail`；`ResultNotice` 收可选 `detail`，
  改用错误框同一个认法 `presentOperationFailure`，原话只拿来认类别、不上屏。`{...operation}` 展开的页面自动带上；直接写
  `error={operation.error}` 的 19 处、`error={resource.error}` 的 7 处、两者拼起来的 6 处（谁的报错在显示就给谁的 `detail`，
  设置页的保存失败和系统信息失败不给），以及 Mac 卸载框都补传了 `detail`。顺带：不带路径、但认得出类别的英文（例如 ENOSPC），
  页头红条现在也有标题，和错误框一个说法。
- 第三十批 B：`electron/codex-extensions.ts` 的 `parseTomlFile` 解析失败时只报「（第 N 行附近）」，不再把 @iarna/toml 的原话
  （会抄出出错那行上下几行，客户自己加的外接工具令牌常在旁边）拼进报错；读文件自己的失败（超上限、读的时候被换掉、被拒绝）
  挪到 try 外照原样抛。`tomlErrorLocation` 从 `config-files.ts` 挪到新的 `electron/toml-error-location.ts`，两边共用。
  `errorMessage` 和 `keySyncFailureReason` 原样放行中文原话时也过一遍 `redactSecretPatterns`（新手引导和「给客服看的原话」早就打码）。
- 第三十批 C：新增 `electron/broken-config-advice.ts`（`describeConfigReset`、`describeBrokenConfig`），读不懂原配置时的那句
  统一从这里出：哪里坏了（TOML 只报「（第 N 行附近）」）、星芒没改、去首页工具行「…」→「配置」→「使用星芒账号」→「高级」→
  「重置为初始状态」。`config-files.ts` 的 `requireJson` / `requireToml` / `requireGeminiJson` 加可选的 `brokenTool`，只有
  merge 那几处（Claude Code、Gemini CLI、Grok CLI）传；Codex 的 config.toml、星芒替 Codex 存的那份、Grok 默认模型那句直接改；
  `codex-extensions.ts`（B）那句也换成 Codex 那句。不传的地方（开机核对型号名单、画图登记、信任文件夹、切回官方账号）照旧。
  行为不变：merge 照旧拒绝改坏的文件，reset 照旧先备份再重建。已知指不到路的：Gemini 没登录、或 Key 不是当前账号缓存里那把时，
  配置窗口里没有「重置为初始状态」；Codex 的 auth.json 坏了 reset 也救不了，那句没改。
- 第三十批 D：新增 `features/tools/external-client-notice.ts`：`externalClientSavedTone` 让「配置已保存」那块在自检结论为
  warn/bad 时用 `warn`，通过、未配置、这次没测成照旧 `ok`，字不改；`accountKeyListFailureText` 拼句前去掉原因结尾的句号。
- 第三十批跟进项：`electron/updater.ts` 的 `describeUnrecognizedUpdateFailure` 判中文改用 `isChineseSentence`。以前判的是没脱路径
  的原话，Windows 中文用户名（或 Mac 上路径里的「星芒AI管理工具」）让英文原话整句交给界面，更新页、首页气泡、「必须更新」那道门
  脱敏后显示成「…, open '本地配置文件」。原话照旧进 `detail` 和运行日志。
