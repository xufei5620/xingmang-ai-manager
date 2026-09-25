## 用户

- 顶部搜索框能搜到的东西变多了：搜「充值」「余额」直接打开个人中心的充值页，搜「密钥」「Key」打开密钥页，搜「开机」「通知」「隐私」打开设置里对应的那一栏，搜「打不开」「装不上」列出相关的教程。结果按「页面」「个人中心」「设置」「教程」分组，回车打开第一项。一个都没搜到时，可以点「去教程里搜」，把输入的字带到教程页接着找。加速口令照旧在这里输入。

## 开发

- 新增 `src/renderer-v2/features/shell/command-search.ts`（纯函数 `searchCommands`）：顶部搜索的索引从 16 个页面扩到个人中心分页、设置分组和教程主题，组内按「名字完全一样 < 名字开头 < 名字里有 < 常用说法 < 教程正文」排序，教程最多列 5 篇；个人中心分页按当前账号能不能打开过滤（`accountTabVisible`）。
- 常用说法放在注册表：`registry/business.ts` 的 `accountTabs` / `settingsGroups` 各项加 `keywords`，`registry/pages.ts` 新增 `pageSearchKeywords`（`Record<PageId, …>`，漏页是编译错）。
- 教程页的全文匹配挪到 `features/tutorial/tutorial-search.ts` 与顶部搜索共用；`TutorialPage` 的 `topic` 多一个可选 `query`，外壳的「去教程里搜」经 `App.tsx` 的 `searchTutorial` 带过去。外壳 `navigate` 带上分页参数；搜索框读屏名改为「搜索页面、设置和教程」。加速口令的判断和优先级不变。
