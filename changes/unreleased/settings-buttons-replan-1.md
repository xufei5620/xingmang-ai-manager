## 用户

- 设置重新排了一遍，常用的更好找：「关于」改名「更新与关于」，「启动时检查新版本」「自动更新」搬了进去；「账号」里能直接切换账号，
  「网络」里加了「企业证书」，一点就到检查页的「安全证书」那一项；通知的几类提醒放在「提醒哪些事」下面，总开关关着时会说明。
- 改了设置不再往页顶插一条提示把页面往下顶，存好了在下方弹一个会自己消失的小提示；还没读到的项写「暂未读到」，可以点「重新读取」，
  不再误写成「此版本暂不支持」。
- 顶部搜索能搜到设置里的每一项（比如「自动更新」「收不到通知」「开机」），点了直接翻到那一行；搜索框打字时不再上下跳。
- 左边侧栏的「更多」和「设置」固定在底部，窗口再矮也看得到，「更多」展开没展开下次打开照旧；账号卡更紧凑，余额没读到时写「—」。
- 「更新」页可以直接开关「启动时检查新版本」和「自动更新」；「帮助与客服」改成左右两栏，并列出了「更多」里的安装卸载、备份、更新。

## 开发

- 按钮与设置重新规划第 1 个 PR（一、二、三部分，第六部分 1～3 条，五-51）。`registry/business.ts` 新增 `settingsItems`（每一行的 id、组、
  标题、常用说法、出现条件）与 `settingsItemLabel` / `settingsItemAvailable`：设置页行标题和顶部搜索读同一份，行 id 不许和组 value 撞名
  （`business.test.ts` 钉住），`app-check.mjs` 把注册表和设置页逐组对一遍（次序、这台电脑该有的行一行不少）。
- 新增 `features/app/row-focus.ts`（`requestRowFocus` / `useRowFocus`）：搜索结果或「企业证书」按钮跳过来时，目标页画好后按
  `data-anchor` 找那一行（最多等 2 秒），滚到正中、焦点给第一个可用控件、亮 2 秒；减少动画时改为一圈内描边。`SettingRow` /
  `ListRow` 加 `anchor`，检查页每项以检查代码作 anchor。
- `Dialog` 加 `headless`（不画标题行和关闭按钮，标题只给读屏，框顶固定在 100vh/6），只给命令面板用。
- 侧栏：「更多」「设置」移进 `.v2-sidebar-pinned`，展开状态存 `xingmang-v2-sidebar-more`；上段导航按滚动位置写 `data-fade` 渐隐，
  换页时把当前项滚进可视区；`@media (max-height: 659px)` 把导航行收到 32，这是固定 1280 版式下唯一的高度断点（规则文件已登记）。
  `AccountView.sourceLabel` 换成 `sourceTag` + `restoring: 'pending' | 'retrying'`。
- 设置页保存成功改走 `useToast`，`ResultNotice` 加 `retry`；系统状态没读到时写「暂未读到」并可「重新读取」。更新页的两个开关与设置页
  通过 App 的 `appSettings` 保持同步。e2e 业务夹具补 `ToastProvider`、`fail=platform-read`、`autoUpdate`。
