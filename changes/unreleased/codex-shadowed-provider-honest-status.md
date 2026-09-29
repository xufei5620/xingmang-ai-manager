## 用户

- 以前接入过 Codex、设置里有一处 Codex 自己认不出的老用户：首页不再显示「已配好」，改成「连接设置要修」，旁边一颗「修好它」；直接点「打开」也会先替你修好再打开。改之前会先备份原来的设置，在「备份」里能找回。
- 检查页的连接自检遇到这种设置会照实说「打开会连不上」，不再显示正常。

## 开发

- 接 #619/#641 的尾巴（第十七批候选 1）：`inspectProviderConfig` 给 Codex 新增 `codexProviderName` 与 `codexProviderShadowed`（活动名是保留名、那张表的地址属已登记站点）。`actualBaseUrl` / `matchesRelay` 不变，切回官方、删中转表、启动门禁照旧。
- 渲染层 `connectionReady` 遇到 shadowed 返回假，`sourceFor` 不变（「切回官方账号」菜单项保留）；首页状态 `codexShadowed` + 「修好它」走 `config:switch-account-source`（备份、写入、自检、失败回滚）；`launch` 在修完就能用时先修再打开。开机恢复账号对有归属记录的配置会自然重写；没有归属记录的不自动改（待定）。
- 连接自检在配置层拦下 shadowed（`config` 层，不发请求）；反馈报告的 Codex 行带上连接名。
