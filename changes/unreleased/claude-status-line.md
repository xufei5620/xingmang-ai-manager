## 用户

- Claude Code 的终端底部多了一行状态：当前模型、当前目录、上下文用了百分之几，
  快满时还会提示「接近上限，会自动压缩」。自己配过状态行的不受影响，保持原样。

## 开发

- 第六批候选 6。新增 `electron/claude-status-line.ts` 与随包脚本
  `bundled-catalog/cli-status-line/xingmang-statusline.cjs`（随 `files` 进包、随
  `extraResources` 落到 asar 外——命令由外部 node 执行，读不了 asar 里的路径）。
  `saveProviderConfig` 新增可选参数 `claudeStatusLineCommand`，缺省 = 不写状态行；
  `system-service.ts` 在写 Claude 配置前解析一次托管 Node 的绝对路径，解析不到、脚本没
  随包拷进来、或路径里带 `"` `$` 反引号 `%` 这类 shell 元字符就不写。
- `merge` 路径只在 `statusLine` 缺省时写；已有的一律不动，唯一例外是本软件自己写过的那条
  （按脚本文件名认），软件换安装位置后把命令指回新路径，否则会变成一条指向旧路径的死命令。
  官方账号模板不写状态行。
- 脚本只读 Claude Code 从 stdin 递来的 JSON，不出网、不读任何配置文件、不碰 Key；
  字段名以 2.1.278 的真实入参为准（`docs/CLI-VERIFIED-VERSIONS.md` 记了抓到的原文与
  `used_percentage` 为 `null` 的坑）。
