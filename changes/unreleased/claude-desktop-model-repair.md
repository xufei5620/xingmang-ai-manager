## 用户

- 在 0.2.12 里配过 Claude Desktop、之后发消息一直没有回复的，升级后打开一次星芒就会自己改好，不用再手动点「保存配置」：星芒会把设置改回你当时选的那一个型号，别的设置都不动，窗口角落会说一句。Claude Desktop 当时正开着的话，完全退出再重新打开就好（只关窗口不算，Mac 上按 Command + Q，Windows 上还要退出屏幕右下角托盘里的 Claude 图标）。

## 开发

- 开机一次性修复 0.2.12（#685）写进 Claude Desktop `inferenceModels` 的多型号清单（#746 只改了以后的写法）。`electron/claude-desktop-model-repair.ts` 在联接策略定下后、开窗前跑一次：
  `listClaudeDesktopProfileCandidates`（`claude-desktop-paths.ts`）列出星芒可能写过的目录（`CLAUDE_USER_DATA_DIR`、Windows 普通版与商店版虚拟化两处、Mac / Linux 各一处），不盘点安装、不起 PowerShell；
  只有工具箱归属记录认领得到的那份 `configLibrary/<id>.json` 才看。
- 认法（`legacyClaudeDesktopSelectedModel`）：清单 2～20 项、全是去过首尾空格的字符串、不重复，第一项之后全是 `claude-*` 且按 `localeCompare` 升序，正是当年 `buildClaudeDesktopModelList` 的输出；网关是 `gateway`、地址是星芒两站之一。
  对上了只把清单改成第一项（和 #746 之后「保存配置」写出的一样），其余字段原样，经 `commitClaudeDesktopFiles` 留一份 `.bak`；对不上（对象写法、顺序变了、混进别家型号、地址不是星芒的、文件解析不了）不碰，只记 `claude-desktop.models.unrecognized` 日志。
- 查完在 `migrations/claude-desktop-single-model-v1.json` 记一笔，以后开机只读这一笔；这次读不出来或写不进去（被占用、读到一半变了）记次数，下次开机再试，最多三次；记录本身写不进去时照样报「改好了」，下次开机再查一遍收尾。不查管理策略、不核对当前账号（理由见 `repairLegacyModelList` 注释）。
- 改成了就在 `window:get-capabilities` 上带可选字段 `claudeDesktopRepaired`（无新增 IPC 通道），renderer-v2 角落卡片 `claude-desktop-repaired` 说一句改了什么、开着的话要完全退出再打开；看不出 Claude Desktop 开没开，按「开着的话」说。
