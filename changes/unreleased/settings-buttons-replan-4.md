## 用户

- 外接工具：自己加的连接排在最上面（卡头「已添加」），「星芒精选」挪到下面；搜索时精选也跟着筛。精选每行只留「安装」，要不要联网在点「安装」后的确认框里说。
  连接检测没做成时写「这次没检测成」，不再写「上次检测」；「重新检测」会先把列表重新读一遍。
- 添加连接、导入技能、添加插件的弹框标题带上工具名，比如「给 Codex CLI 导入技能」；添加连接加了小标题「连接方式」「装到哪里」。
- 技能：选到 Claude Code、Grok CLI 这类不能在这里导入的工具，工具条下面直说原因，点「看怎么放」打开教程里讲这件事的那一条；
  列表空着时给「重新加载」。技能、插件两页都加了「重新加载」。
- 插件：「已安装」先放自己装了的，再放「星芒精选」；没有插件市场的工具在「市场」页签直说，给一颗「去已安装」；Codex 自动下好插件目录时不再多弹一条「已完成」；
  有新版本的插件、技能，行上直接有「更新」。
- 教程：目录去掉「N 分钟」、加宽一点，打开一篇时目录自己翻到它；长文章读到中间时，顶上吸着一条「第 2 步，共 4 步」，点圆点能跳；
  搜索时直接翻到第一处命中，命中的字带浅黄底，只展开含这个词的补充说明；「还是不会？」「联系客服」挪到每篇文章最后。
- 检查：结果挪到最上面，有问题的排最前，正常的收成一行「另外 N 项正常」，点「展开」再看；「导出检查报告」挪到页头；
  从设置、开机提示点进来会直接翻到那一项；连接自检一个工具一行，详细说明点「查看详情」看；结论是网络问题时「去处理」直接打开设置的「网络」。

## 开发

- 按钮与设置重新规划第 4 个 PR（第五部分第 23～39 条，第六部分第 8 条）。外接工具、插件的「星芒精选」挪到自己的列表下面，`CuratedShelf` 卡头 meta 改成一句说明，
  去掉每行的 `curatedNetworkLabels`；`ListState` 加 `emptyTitle` / `emptyDescription`。
- 技能、插件工具条加 `${page}-reload`；外接工具「重新检测」改为先 `resource.reload()` 再检测，检测命令没跑完（`supported` 且带 `reason`）时显示
  `mcp-health-failed`。Codex 进「市场」时自动下载插件目录不再给成功提示，自己点的照旧。插件行在 `update-available` 时加 `${page}-update-${id}`。
- 技能页「看怎么放」走 `navigate('tutorial', 'skills#<补充说明标题>')`；外壳把 `#` 后面拆成教程的 `extra`，教程页只展开并翻到那一条。
- 教程：命中词用 `splitSearchHits` 包 `<mark class="v2-tutorial-hit">`，补充说明只在 `textHasSearchWord` 时展开；吸顶条按内容区（`.v2-content`）的滚动
  算读到第几步（`readingStepAt`），点圆点跳过去的那一步记下来，滚到底时最后两步也亮对；`.v2-content` 上边的留白写成 `--v2-content-padding-top`，
  吸顶条用它贴住正文顶边。
- 检查页：`sortDiagnosticsBySeverity`、`connectionRowStatus`、`sortConnectionRows` 是纯函数；`useRowFocus` 加第四个参数 `resolve`，开机提示的
  「去看看」带 `firstProblemAnchor`，设置「网络检查」带 `XINGMANG_NETWORK`，指名的是正常项时先展开正常项再翻过去。
  `connectionCheckView` 加 `section`，网络那一层落到设置的 `network` 组（检查页、备份页的「去处理」都用它）。
- 测试：`e2e/v2-business-fixture.tsx` 的扩展列表抽成 `extensionList`，每次读都记一笔 `list-extensions`；加 `mcpHealthFail` 让第一次连接检测没跑完。
