# Codex 账号切换与配置保存

本文对应默认 v2 界面中 Codex CLI / Codex 桌面端配置面板的“使用星芒账号 / ChatGPT 账号”及“保存配置”操作。可从首页工具行的配置菜单进入；两个 Codex 工具行右侧更多菜单中的“非 GPT 模型”会打开同一面板，并预选“非 GPT 模型”筛选。首页工具行不再单独显示该按钮。

## 什么时候写入

- 点击账号来源选项只修改面板草稿；不会立即切换、退出账号或写配置。
- 点击面板底部“保存配置”只打开保存方式选择，显示当前来源或密钥名称、分组、脱敏预览及模型。
- 点击“仅更新账号来源、密钥和模型”才执行 `merge` 保存。
- 点击“重置为初始状态”先显示重置范围，确认“备份并重置”才执行 `reset`。返回或取消保留草稿，不执行写入。
- 保存成功后重新读取配置、工具状态和密钥元数据。保存不会自动启动或强制重启 Codex；正在运行的桌面端需要重新打开才能可靠加载新配置。
- “选择文件夹”是独立操作，选定后立即保存工作目录，不等待上述配置确认。

## 星芒切换到 ChatGPT：保留设置

CLI 和桌面端使用同一个有效 Codex 配置目录。正式版优先使用绝对路径 `CODEX_HOME`，未设置时为用户目录下的 `.codex`；开发版还支持 `XINGMANG_CODEX_HOME_OVERRIDE`。不是每次切换都新建一个 Codex 数据目录。

主进程先检查当前配置属于星芒中转，第三方中转会拒绝切换。文件行为如下，路径均相对于有效 Codex 配置目录：

| 文件 | 操作 |
| --- | --- |
| `config.toml` | 优先恢复已保存的 ChatGPT 配置。没有快照时，从现有配置中移除当前星芒 provider 条目以及顶层 `model_provider`、`model`、`review_model`，其他字段保留。 |
| `xingmang-config-relay.toml` | 保存当前星芒 `config.toml`，用于以后切回星芒。 |
| `xingmang-config-chatgpt.toml` | 保存/恢复 ChatGPT 来源的配置；已有快照时以这份配置为准。 |
| `auth.json` | 恢复当前或快照中的 ChatGPT tokens；有登录态时写入 `auth_mode: "chatgpt"`，不混入星芒 Key。没有可恢复登录态时移除 API Key 和认证选择，之后在 Codex 中登录。 |
| `xingmang-auth-apikey.json` | 保存当前星芒 `OPENAI_API_KEY`。 |
| `xingmang-auth-chatgpt.json` | 保存/恢复官方 tokens 和已有 `last_refresh`；切换不生成新的官方登录令牌。 |
| 上述已存在文件的 `.bak.<时间戳>` | 修改前备份；每个文件保留最近 5 份。 |

星芒和 ChatGPT 各自保存配置快照，切换时恢复目标来源的设置。例如星芒的推理参数不会强行覆盖之前保存的 ChatGPT 推理参数。“保留自定义设置”指保留该来源设置，并非把两份配置所有字段合并在一起。TOML 可能重新序列化，字段值保留不代表注释和排版原样保留。

配置文件提交成功后，还会：

1. 在管理工具数据目录的 `settings.json` 中将 `codex` 加入 `officialProviders`，避免下次启动或登录时自动覆盖官方来源。
2. 尝试在 `config.toml` 的 `[[skills.config]]` 中禁用“星芒AI”技能；切回星芒时重新启用。这个开关是保存后的尽力同步步骤。
3. 清除界面中当前站点 Codex 的“手动填写密钥”来源标记。

该操作不退出管理工具中的星芒账号，不撤销服务端 API Key，不修改 Codex 的会话目录、会话数据库或项目文件，也不会替用户完成浏览器 OAuth 登录。

## 星芒配置的保存操作

| 密钥选择 | 保存时的操作 |
| --- | --- |
| 保持当前密钥 | 界面传递空 Key 哨兵，由主进程复用当前本地密钥；不向界面返回完整密钥。 |
| 账号中已有密钥 | 提交 Key ID，由主进程取得对应 Key，使用选定模型。 |
| 自动准备/复用专属密钥 | 按账号实际分组准备或复用工具专属 Key，读取可用模型，确认目标模型，再用所选 `merge/reset` 方式写入一次配置。 |
| 自己填写密钥 | 先检测可用模型；保存时提交输入的 Key、模型及方式。成功后记录手动来源，供以后自动配置时识别。 |

主进程校验 Key 的可用模型和账号/站点状态后才写入。对于 Codex：

- `merge` 优先使用当前星芒配置，或切回星芒时恢复的星芒快照；更新 `model`、`review_model`、`model_provider` 和 provider 的地址、`wire_api`、认证要求。未设置权限策略时补入 `approval_policy = "on-request"`、`sandbox_mode = "workspace-write"`，已有值保留。
- `auth.json` 和 `xingmang-auth-apikey.json` 写入仅包含 `OPENAI_API_KEY` 的内容；切走前的 ChatGPT tokens 另存为官方登录快照。
- 成功后移除 `officialProviders` 中的 `codex` 并恢复星芒AI技能开关。

## 重置范围

重置仍使用面板选定的账号来源、密钥和模型，重建该来源的配置。它不是清空账号、密钥、聊天记录或整个用户目录。

| 来源/工具 | 初始配置 |
| --- | --- |
| 星芒 Codex | 使用项目现有初始模板：选定模型及 provider、`xhigh` 推理、`on-request` 审批、`workspace-write` 沙箱、网络开启及 `features.goals` 等；不预设上下文窗口和自动压缩阈值；覆盖当前配置和星芒配置快照。 |
| ChatGPT Codex | `approval_policy = "on-request"`、`sandbox_mode = "workspace-write"`，模型由官方客户端默认值决定。同步替换官方配置快照，避免以后切换把旧设置恢复回来；保留星芒快照和官方登录凭据。保存后仍会同步星芒AI技能禁用项。 |
| 星芒 Claude / Gemini / Grok | 使用各工具既有星芒初始模板，写入选定 Key、模型和中转地址。 |
| 官方 Claude / Gemini | Claude 重建最小 `settings.json`；Gemini 重建 OAuth 登录方式并清空原配置 `.env`。官方登录凭据独立保留。Grok 不提供官方账号来源。 |

权限、MCP、推理等自定义字段若位于被重建的配置中，会被重置；项目级配置、独立 MCP 文件和历史记录不属于这次写入范围。Codex 使用来源快照隔离；Claude/Gemini 重建的是当前工具配置。

所有计划先写入临时文件，再备份、替换；替换失败尝试回滚。主进程检查配置路径，拒绝符号链接等不安全目标。明确重置星芒 Codex 时，不再解析旧星芒快照，损坏的快照可以被备份后替换。

## Codex 非 GPT 模型：协议限制与验证状态

从首页 Codex 工具行右侧更多菜单中的“非 GPT 模型”进入后，选择当前工具已配置的星芒 Key、账号已有 Key 或自行填写 Key，点击“检测模型”，再显式选择本次检测出的非 GPT 模型。面板中也可以在“全部模型 / 非 GPT 模型”之间切换。

筛选按模型名称识别 GPT、ChatGPT、Codex、OpenAI 命名空间及 o 系列，只改变候选列表，不建立模型协议兼容性的结论。已有选择即使不符合筛选也会显示为不可选的当前项；不会自动将它换成另一个模型。未检测、检测结果没有非 GPT 模型或未显式选中合格候选时拒绝保存。使用 ChatGPT 官方账号或“自动准备专属密钥”时，非 GPT 模式会提示切换到已有星芒 Key 或手动 Key，再检测模型。

当前 Codex 自定义 provider 始终使用 `wire_api = "responses"`，保存所选模型 ID 时不会根据模型家族改为 Chat Completions。2026-09-17 使用桌面端内置 `codex-cli 0.153.4` 在临时配置目录运行 `features list`：相同 DeepSeek 模型名配合 `chat` 时退出码为 1，报 `wire_api = "chat" is no longer supported`；改用 `responses` 时退出码为 0。该协议约束也与已核实的 [官方 WireApi 源码](https://github.com/openai/codex/blob/b0659c53865dd48b0cd69c454368cea3980017cc/codex-rs/model-provider-info/src/lib.rs#L91)一致。

实际可用仍要求中转为该模型提供兼容的 `/v1/responses`、流式事件及工具调用；模型列表中出现名称不代表这些能力已经验证。只有 Chat Completions 的上游需要 Responses 协议适配，不能通过改 `wire_api` 实现。

本轮进一步使用同一官方 CLI、隔离目录与当前真实配置写入器进行了 localhost mock 验证：非 GPT 模型 ID 的 Responses 流式文本、HTTP 400 错误处理、应用层取消三项通过；工具调用返回 `function_call_output`，但命令被本机执行策略阻断，完整工具执行断言未通过。取消后 HTTP 连接没有立即关闭。当前模板还会发送 `reasoning.effort=xhigh` 与 `summary=auto`，客户端对未知模型使用 fallback metadata；生产渠道是否支持这些字段尚未验证。完整证据和限制见 [Codex 隔离验证报告](../artifacts/codex-non-gpt-client-audit-report.md)，不能将该报告视为真实星芒推理或 Desktop UI 验收。

本轮 v2 全 App 浏览器测试 78/78 通过，覆盖本轮界面接入及页面按需加载后的回归；定向单元测试验证筛选与保存边界。这些结果与真实非 GPT 上游验收分开记录。WorkBuddy、Claude Desktop 和 OpenCode 的首页入口及各自协议见 [外部客户端配置](EXTERNAL-CLIENT-CONFIG.md)。

## 一次性上下文配置迁移

包含本次修复的版本首次启动时，在恢复账号和显示主界面前，检查有效 Codex 目录下的 `config.toml` 和两份账号来源配置快照，删除根级 `model_context_window`、`model_auto_compact_token_limit` 字段。其余配置值保留，不修改认证文件；有改动的文件沿用备份和事务回滚机制，避免账号切换后恢复旧限制。

检查成功（包括文件不存在或没有这两个字段）后，在工具箱用户数据目录的 `migrations/` 中按 Codex 目录记录固定迁移标记。以后启动和版本升级不再检查该目录；用户随后自行添加的字段会保留。读取、解析或写入失败会记录日志，不阻止启动，也不标记完成，下次启动重试。自定义 `CODEX_HOME` 与开发环境隔离目录分别记录。

## 本次实现文件

| 源码 | 改动 |
| --- | --- |
| `src/renderer-v2/features/tools/Home.tsx`、`src/renderer-v2/App.tsx` | 默认 v2 首页 Codex 工具行的“非 GPT 模型”入口，打开共享配置面板并启用对应筛选。 |
| `src/renderer-v2/features/tools/model-filter.ts` | 按名称筛选模型；要求先检测并显式选择，拒绝用不符合筛选的旧选择保存。 |
| `src/renderer-v2/features/tools/ConfigDialog.tsx` | 模型筛选；保存弹窗展示两种动作；重置范围确认；所有来源透传保存方式；保留预览、错误重试、忙碌锁和取消草稿行为。 |
| `src/renderer-v2/app.css` | 两个操作按钮分行展示标题与说明，适配明暗主题及长文本。 |
| `src/renderer-v2/features/tools/api.ts` | 官方账号和自动密钥调用传递 `mode`。 |
| `electron/ipc-contract.ts`、`electron/preload.ts`、`electron/ipc.ts` | 扩展并校验可选保存模式，旧调用继续默认 `merge`。 |
| `electron/system-service.ts` | 官方切换向配置写入层传递保存方式。 |
| `electron/config-files.ts` | 保存所选模型并保持 Responses 协议；官方来源支持备份后重置；同步重置官方快照；显式星芒重置跳过旧 relay 快照解析。 |
| `electron/account-cli-provisioner.ts` | 自动密钥使用指定保存方式，配置仅写一次。 |
| 对应主进程测试及 `src/renderer-v2/testing/app-check.mjs` | 验证快照/登录/历史保留、备份与回滚、IPC兼容、所有密钥来源的模式传递、取消和失败重试、明暗主题及焦点。 |
