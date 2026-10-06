## 用户

- Claude Code、Gemini CLI 的设置文件坏了、工具自己都读不了时，首页也会写「配置文件坏了」，点「修好它」先备份、再重新生成，历史会话保留。以前首页把它写成「官方账号」，点「保存配置」还说已经在用自己的官方订阅。
- Codex 读不了自己的登录信息时，首页同样写「配置文件坏了」，「修好它」和配置里的「重置为初始状态」都能修好。以前重置也报读不懂。
- 从当前账号切回 Codex 官方账号、以前又没登过 ChatGPT 的，Codex 会请你重新登录。以前会留下一份空的登录信息，Codex 一用就报错，桌面端停在「无法加载组织设置」。
- 来源没确认时，配置窗口里的「改用当前账号」遇到工具读不了的配置，会先备份再重新生成，不再只说写错了。

## 开发

- 新增 `cli-config-health.ts`：Claude Code 2.1.277、Gemini CLI 0.60.0、Codex 0.159.0-alpha.12.1（桌面端 26.930 自带）各自读不读得了
  自己的 JSON 文件，每条都在沙箱里拿真工具试过：Claude Code 弹「Settings Error」整份不用的写法，Gemini CLI 退出码 52 的写法，
  Codex 不报错、当成没登录的 `auth.json`。本软件自己的读法更宽（去掉 BOM、坏字节换成 U+FFFD），读得出 Key 不代表工具读得了。
- `config-files.ts`：`codexConfigBroken` 改名 `configBroken`，Claude Code、Gemini CLI 的 `settings.json` 也判（Grok CLI 不判）；新增
  `codexAuthBroken`。reset 遇到读不懂的 `auth.json` 先备份再照常重建，merge 照旧报错、指去重置。新增 `FileRemovePlan`：同一次两阶段
  提交里整份拿掉一个文件，提交时先挪到临时名，后面的文件提交失败照样从 `.bak` 放回。`createCodexOfficialAuthPlans` 在没有可换回的
  ChatGPT 登录、文件里只剩 `tokens` `last_refresh` 或什么都不剩时拿掉 `auth.json`，和 Codex 自己退出登录一样：实测 Codex 把 `{}`
  当成 ChatGPT 登录，`codex exec` 报 plan type is required for chatgpt authentication。`switchProviderToOfficialAccount` 遇到读不懂的
  文件，merge 改说 `describeBrokenConfig` 那句，不再说「无需切换」；Claude Code、Gemini CLI、Grok CLI 切回官方读不懂时也用这句。
- `ipc.ts`：一键切换（`config:switch-account-source`）改用当前账号时，文件读不懂就用 reset，切换开头已经在「备份」页留过一份
  （第三十批跟进项「来源未确认时点不到重置」）。
- 首页：`brokenConfigOf` 分出四种坏文件（Codex 的 `config.toml` `auth.json`，Claude Code、Gemini CLI 的 `settings.json`），各一句小字；
  坏了时模型那一格不写「官方账号」。`brokenConfigRepairTarget` 按坏的是哪份决定「修好它」走哪边：Codex 登录 ChatGPT、或只坏了
  `auth.json` 且 `config.toml` 没有别的服务地址、Gemini CLI 读得出 Google 登录的走官方重置，其余按当前账号。配置窗口遇到坏文件、
  官方账号只是推出来的，默认选「使用星芒账号」，展开「高级」重置就和「修好它」一样。
- 测试：`cli-config-health.test.ts` 钉住三个工具读得了和读不了的写法；`config-files.test.ts` 加首页标记、坏 `auth.json` 的两种重置、
  切回官方不留空文件、留着别的内容就不拿掉、拿掉后回滚放回、Claude Code 与 Gemini CLI 切回官方读不懂时指去重置；`ipc.test.ts`
  加一键切换遇到坏文件走 reset；`Home.test.tsx`、`model.test.ts` 加三种新坏法、优先级与修的方向；`app-check.mjs` 两条浏览器回归
  （夹具 `?claudeBroken`、`?codexAuthBroken`）。
