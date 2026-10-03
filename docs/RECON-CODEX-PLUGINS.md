# Codex 原生插件目录与本地安装研究记录

研究日期：2026-10-04。本文保留机制与实验事实；当前用户要求、实施方案和验收以 [官方插件随包预置方案](CODEX-OFFICIAL-PLUGIN-BUNDLE-PLAN.md) 为准。研究中考虑过的小批精选／用户按需开加速，不是本次全量官方目标的交付方案。

## 1. 版本与证据类别

| 对象 | 基线 |
| --- | --- |
| 星芒初始研究源码 | main，1eee5f0f2dbc3020e3dd6a6130912437d7e464d3（#778，在 v0.2.14 发布之后，package.json 仍是 0.2.14） |
| 方案 PR 基线 | main，4cbd71730d1fc59553670d820e1662b99c72a7a1 |
| Windows 安装包 | OpenAI.Codex 26.930.3930.0 |
| 应用内部版本 | 26.930.31730，build 12947 |
| 桌面内置运行时 | codex-cli 0.160.0 |
| PATH 中 CLI | @openai/codex 0.157.1，未用它代替桌面验收 |
| 对应 Codex 上游 | rust-v0.160.0，a956835d020762cb2b570053af06f643a11c0ecc |
| 固定公开插件目录 | openai/plugins，5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f |

证据包括固定官方源码、已安装官方 app.asar 的静态目标文件、独立 CODEX_HOME 的 CLI/RPC 实验、真实官方插件完整样本以及文件体积统计。没有修改已运行桌面或真实用户配置；没有调用生产 xm.solov.cc、模型或第三方 OAuth。

## 2. 官方目录与登录方式

`target_curated_marketplace` 根据认证模式选择目录。API Key 与未登录都走 `openai-api-curated`，使用 `.tmp/plugins/.agents/plugins/api_marketplace.json`；ChatGPT 身份的远程目录有独立分支。模型中转 base URL 不改变这个身份选择。[固定源码](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core-plugins/src/manager.rs#L660)

启动同步依次尝试 Git、GitHub HTTP、ChatGPT export。30 秒超时按每条 git 命令／每个 HTTP 请求计，不是每种方式合计 30 秒；ChatGPT export 只在本机还没有快照时才用，不拿它刷新已有快照。每种方式都先解到临时目录、成功才换上；失败时旧快照原样保留，只记一条警告。`.tmp/plugins/.agents/plugins/marketplace.json` 与 `.tmp/plugins.sha` 都在才算已有快照。[启动同步实现](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core-plugins/src/startup_sync.rs#L96)

固定公开清单：API 版 50 项，其中 47 local、2 url、1 git-subdir；完整市场 65 项。远程三项为 crowdstrike-falcon-foundry、crowdstrike-falcon-fusion、qodo。这些数值只用于该提交的事实，不等于云端所有账号、所有版本的全部目录。[固定 API 清单](https://github.com/openai/plugins/blob/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/.agents/plugins/api_marketplace.json)

同一提交里 64 份插件 manifest（62 个插件加 2 个测试夹具）有 8 份写 `Proprietary`（如 codex-security、openai-developers），11 份没写许可证，1 份写 `UNLICENSED`。能否随星芒转发要逐项落实，见方案 4.4。

OpenAI 文档说明 API Key 支持部分精选插件，某些 OAuth 能力不可用。因此资源存在不能证明完整官方集合在 API Key 模式下都可见，更不能证明账号功能都可使用。[官方可用性说明](https://learn.chatgpt.com/docs/plugins#api-key-availability)

## 3. 桌面 UI 静态核查

从同一官方安装包提取了相关 JS。下面的偏移是 UTF-8 文本解码后的 JavaScript 字符偏移，仅服务于此版本定位。

| 文件／函数 | 已确认行为 |
| --- | --- |
| app-shared-2d992d47c83d.js，e4/yUr，约 5223100 | plugin/list 带 cwds、可选 marketplaceKinds、forceRefetch；查询 staleTime 为六小时 |
| 同文件，RHr/zHr，约 5217040 | 远程官方市场开关启用时，只按名称过滤旧 openai-curated，不过滤 openai-api-curated |
| 同文件，ZHr/QHr，5219184 / 5219280 | 官方分类比较归一化后的市场名称或展示名称 |
| app-initial-74dc12f48352.js，_no/qno，6584312 / 6591885 | API Key 下远程首页为 null 时可构造本地官方分类；已启用云端查询报错不是自动本地回退 |
| plugins-query-217dcadc5f0f.js | 个人创建／工作区分享云端查询要求 authMethod 为 chatgpt |
| category-plugins-query-59bff0f481d5.js | 云端分类查询要求 ChatGPT 身份 |

真实 API 精选清单展示名为 `Codex official`，规范化为 `codex-official`，在本版本官方分类名单内。故不能因为市场名 `openai-api-curated` 不在该名单，就推断真实官方列表一定不显示；也不能把官方展示名改成测试夹具名称后再推断正式 UI。

供复核的 SHA-256：

```text
app-shared-2d992d47c83d.js
5e3a36d643393af861d2009584f64289f2247928e793f1985fe12cfec803a40b
app-initial-74dc12f48352.js
7fe079aa06167a43e8f6b638f341f1171474a5980b6d08d6bb9b32613c62a797
plugins-query-217dcadc5f0f.js
91f06b9da3cb8b8857f6f71ac79a51f3b51eee1c6e79675caa949ae63a17ecb4
category-plugins-query-59bff0f481d5.js
d0645a113226732720a95664f87be4282a9ca8a9465e8c63c6ecaba4e2e1af72
```

没有向 PR 添加提取后的官方 JS 或用户缓存；表中结论是静态机制证据，不是原生窗口截图验收。

## 4. 文件安装链路

Local source 直接用清单里的现成目录；Git source 先 clone 到临时目录，npm source 先按包名、版本和 registry 取到临时目录；三种最后都由 `replace_plugin_root_atomically` 复制进 cache 再改名到位。CLI `plugin add` 和 native `plugin_install_response`（本地市场路径）都调用 PluginsManager.install_plugin；带 remoteMarketplaceName 的请求走远程安装分支。[source 分支](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core-plugins/src/loader.rs#L1739)、[native 安装](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/src/request_processors/plugins.rs#L1462)

原生安装随后还处理 cache 刷新、配置重读、MCP/hooks 和需要授权的 Apps。安装文件成功与远程能力授权是两件事。Curated cache 版本可来自快照 SHA 前八位，不能把所有本地插件版本一概写成 local。

个人、项目和注册的本地市场是支持的入口。稳定 CLI `plugin marketplace add <root> --json` 可以注册专属来源，避免覆盖用户个人市场。[命令文档](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)、[本地市场规范](https://developers.openai.com/plugins/build/plugins)

Native `plugin/list` 的 forceRefetch 主要控制远程目录缓存，并非官方 GitHub 快照强制下载命令；官方快照由另一个 startup sync 流程管理，只在启动时、且远程全局目录没启用时才跑，plugin/list 不会触发它。[列表处理](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/src/request_processors/plugins.rs#L546)

## 5. 隔离验证记录

实验使用桌面内置 0.160.0，独立 CODEX_HOME、占位 API Key、localhost 模型 URL、不可达 localhost HTTP/HTTPS 代理，PATH 不包含 Git。Fixture 不含 MCP、apps 或有效 hooks。没有启动模型回合，没有执行插件脚本。

| 操作 | 结果 |
| --- | --- |
| --version 与 generate-json-schema --experimental | 成功，使用该 binary 生成实际协议 schema |
| plugin list --available --json | 返回准备的 openai-api-curated 本地 fixture |
| plugin add research-curated@openai-api-curated --json | 成功；读回 installed/enabled 均为 true |
| plugin marketplace add 本地根目录 --json | 成功，专属 xingmang-research 市场在册 |
| plugin add research-local@xingmang-research --json | 成功，落入该隔离 CODEX_HOME 的 cache |
| 独立 app-server plugin/list、plugin/read | 返回中文展示字段、可安装状态和详情 |
| plugin/install、再次 plugin/list、skills/list | 安装成功；appsNeedingAuth 为空；技能可被扫描 |

CLI 的七个命令退出码均为 0；上述 RPC 没有协议错误或交互授权请求。研究期间没有操作当前桌面会话。

### 真实官方精选样本

从固定公开 commit 获取 `plugins/superpowers` 完整子树：Superpowers 6.3.0，73 文件、491,516 bytes、14 skills，含许可证和引用资产。Tree SHA 为 `ebebbff97c8ec8f77959080df80f4d57478f65e8`。Manifest 是 skills 包，hooks 为空，无 mcpServers/apps；作者为 Jesse Vincent，官方收录不等于 OpenAI 自研。

每个下载文件的大小和 Git blob SHA-1 匹配；本地预置后使用桌面内置 CLI 安装，再独立计算源目录与 cache 的 SHA-256。结果摘要：

```json
{
  "sourceCommit": "5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f",
  "sample": "superpowers 6.3.0",
  "sourceFiles": 73,
  "installedFiles": 73,
  "allFileHashesMatch": true,
  "installed": true,
  "enabled": true
}
```

安装版本标识为 `5fd93af4`。样本脚本没有被执行，不能据此声称整套工作流在中转模式已验收。[固定样本来源](https://github.com/openai/plugins/tree/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/superpowers)

### 复现时的边界

使用新建目录和目标桌面 binary，先生成 schema，再按顺序 initialize → initialized → plugin/list → plugin/read → plugin/install → plugin/list → skills/list。只使用无执行能力的 fixture 或审查后的固定样本；禁止连接当前用户正在运行的 app-server。

Windows 的 skills 扫描会读操作系统 home 的 `.agents/skills`，不完全服从测试 HOME。实验曾读到一个已有公开技能，故只能主张插件状态／凭据隔离，不能称所有 home 路径隔离。[home roots 实现](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/ext/skills/src/host_roots.rs#L28)

官方将外部 plugin/list/read/install RPC 标为开发中，不建议第三方生产客户端依赖；本次仅将它用作隔离实验。产品走受支持的资源格式、稳定 CLI 与原生操作。[接口成熟度](https://learn.chatgpt.com/docs/app-server)

## 6. 本仓现状

- `inspectCodexPluginCatalog` 检查市场清单和版本 marker；没有证明清单引用的每个插件实体都完整。
- `ensureCodexPluginCatalog` 已有下载限制、staging、原子发布和回滚，但完整快照直接 present；缺少强制刷新及随包输入。
- 当前入口是 `ProviderExtensionService.ensureMarketplace('codex')`，由星芒「插件 → 市场 → Codex」页触发（目录缺了进页自动下一次，失败后留按钮手动再点）；原生桌面启动和单纯 list 不主动准备。
- `createCodexDesktopAccelerationCoordinator` 对 API relay 的自动会话在约两分钟后收回；不能把这个时限当作后续插件下载保障。
- 下载专用 lease 只设置星芒下载分区，不自动作用于另一个 native 进程。
- Windows 走 `buildCodexDesktopLaunchPlan`（Explorer 打开 AppsFolder）或 AppModel 激活，都没有显式传入解析后的 codexEnv；macOS 的 `buildMacosCodexAppLaunchPlan` 用 `open --env CODEX_HOME=…` 显式传。需在真正使用的用户 root 对账。
- 现有「星芒精选」的插件市场来源表 `curatedMarketplaceSources` 只有 Claude 官方市场一条（精选里的 MCP 与技能另算），不能直接作为全量官方 Codex 插件交付实现。

对应位置：`electron/codex-plugin-catalog.ts`、`electron/provider-extensions.ts`、`electron/main.ts`、`electron/codex-home.ts`、`electron/codex-desktop-service.ts`、`electron/macos-codex-app.ts`、`electron/codex-desktop-acceleration.ts`、`src/renderer-v2/registry/curated-extensions.ts`、`src/renderer-v2/pages-management.tsx`。引用符号与相对路径，避免让行号承担版本契约。以上七条在 main 8756f9d（#813）上逐条对过代码。

## 7. 容量统计与结论限制

本机完整公开目录已有文件 53,671,331 bytes（51.18 MiB），gzip level 6 为 24,168,707 bytes（23.05 MiB），5,386 文件。该本地快照完整市场 65 项，API 市场 49 项；它不是上面固定上游 50 项样本，因此不得混用数量。

官方桌面自带资源 46.75 MiB；当前四个 OpenAI 来源 cache 合计 106.996 MiB，跨市场有重叠，仅为已缓存副本。统计没有压缩用户 cache，跳过一个 reparse，读取错误为零。完整快照压缩测量不含三个远程 Git 来源实体和额外运行环境。

因此随包容量和 300～500 MiB 磁盘预留只能作为初步估算，最终全量包要重新计量。容量小不能替代分发资格或账号能力验证。

当前仍缺：真实原生 UI 全量可见与点击安装、三远程源无上游联网安装、API Key 与 ChatGPT 参考目录逐项对齐、真实授权与插件功能、macOS 以及发布资源包验证。完整实施及这些阻断的处理见 [方案](CODEX-OFFICIAL-PLUGIN-BUNDLE-PLAN.md)。
