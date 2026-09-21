## 用户

- 插件页选中 Claude Code 时多了一张「星芒精选」卡，挑好了五个官方插件：代码审查、提交与合并请求、
  功能开发流程、前端界面、项目说明维护。每条都写清它能让 Claude Code 多做什么、装完在哪儿用、
  要付出什么代价（多用额度、会动 Git 仓库这类），点「安装」会先把将要执行的两条命令原样列给你看。
- 精选里已经装上的那几条不再给「安装」按钮，改成标一个「已安装」，不用点进去才知道装过了。

## 开发

- N6 第二步：`bundled-catalog/curated-extensions.json` 加 `kind: 'plugin'` 的五条（清单 `version` 2），
  新增 `install` 形态 `{type:'plugin', marketplace, plugin}` 与字段 `marketplaceCommit`。
  `curatedMarketplaceSources` 把清单能指向的市场限定在应用真会注册的官方那一个，插件名收窄到
  `[a-z0-9-]`；插件条目没写 `pinnedVersion` 也没写完整 40 位 `marketplaceCommit` 的会被解析层整条丢掉。
- `claude plugin install` 没有钉版本的开关（2.1.277 实测），所以确认框明写「安装的是官方市场当前的版本，
  我们复核过的是 <短 commit> 那一版」，并列出 `marketplace add` 与 `install` 两条命令。安装仍走
  `mutateProviderExtension`（`kind: 'plugin'`），市场在册由主进程 `ensureClaudeOfficialMarketplace`
  保证（#277），精选不新开通道。
- 入选与排除理由、钉不住版本的取舍、复核时重新取事实的命令写进 `docs/CURATED-EXTENSIONS.md`
  新增的「插件精选」一节。`security-guidance` 因 hooks 要 Python + bash 被排除。
