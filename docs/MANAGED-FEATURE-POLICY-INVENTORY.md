# 星芒管理策略逐项清单

基线：`e97392ab7e8e6aa99305b0e56f48cec61c4a4688`，2026-10-04。总判断、证据等级和修复顺序见 [审计报告](MANAGED-FEATURE-EFFECTS-AUDIT.md)。本表覆盖当前管理路径的策略族，不把每个 return false、加载中按钮禁用或类型默认值计作关闭外部功能。

`reset` 指用户显式重建配置；`merge` 指普通保存/合并；“补缺”指启动升级的缺省模板补齐。三者不同。表中“保留”仅指该分支，不是承诺任意账号快照/后续保存永远不变。

主要文件索引：

- CF：[config-files.ts](../electron/config-files.ts)
- SS：[system-service.ts](../electron/system-service.ts)
- CLI：[tool-installation.ts](../electron/tool-installation.ts)、[cli-hooks.ts](../electron/cli-hooks.ts)
- 网络与环境：[command-runner.ts](../electron/command-runner.ts)、[download-proxy.ts](../electron/download-proxy.ts)、[proxy-bypass.ts](../electron/proxy-bypass.ts)、[download-acceleration.ts](../electron/download-acceleration.ts)
- 扩展：[xingmang-ai-mcp.ts](../electron/xingmang-ai-mcp.ts)、[xingmang-ai-skill.ts](../electron/xingmang-ai-skill.ts)、[provider-extensions.ts](../electron/provider-extensions.ts)、[codex-extensions.ts](../electron/codex-extensions.ts)

## A. Codex 持久配置和模型资料

| ID | 设置/能力 | 写入、条件与原值处理 | 恢复与影响 | 证据位置 |
| --- | --- | --- | --- | --- |
| C01 | 使用统计 | 缺省补 analytics.enabled=false；已有 true/false 保留 | 官方快照优先恢复；无快照按单键 false 的形状删除，存在来源误判；当前桌面连带禁用功能缓存 | CF disableCodexRelayAnalytics / restoreCodexAnalytics；F01/F03 |
| C02 | CLI 启动更新提示 | 新建/reset false；merge 强制 false；补缺仅缺省 false | 官方 reset 也 false，无快照切官方不撤销；不是桌面应用更新总开关 | CF applyCodexRelayConfig / createCodexOfficialConfigPlans / fillCodexRelayTemplateDefaults |
| C03 | 共享 daemon 自动启动 | features.daemon_auto_start=false，仅缺省写 | 无快照切官方残留；已有 daemon 可能复用，agents 有独立路径 | CF applyCodexRelayMachineDefaults；CLI cliLaunchArgv |
| C04 | 任务期间自动睡眠 | features.prevent_idle_sleep=true，仅缺省写 | 用户 false 保留；无官方快照时不撤；开启能力，耗电/睡眠体验须实机 | CF applyCodexRelayMachineDefaults |
| C05 | Windows 原生沙箱种类 | Windows 缺省 sandbox=unelevated，用户 elevated 保留 | Mac 不写此表；无快照切官方可能残留；不是取消 sandbox | CF applyCodexRelayMachineDefaults |
| C06 | 审批与写入模式 | 缺省 on-request / workspace-write | 显式策略保留；没有批量改为 danger-full-access | CF applyCodexRelayConfig / ensureCodexPermissionDefaults |
| C07 | 工作区信任 | 单独信任入口把所选项目 trust_level=trusted | 是用户选择的目录，不是全部磁盘；不自动撤回 | CF trustCodexWorkspace |
| C08 | goals | 新建/reset 写 features.goals=true | merge/补缺不补；新旧用户可能不同，属于开启 | CF buildCodexRelayConfigTemplate |
| C09 | 聊天与审查模型 | 保存强制 model、review_model 为所选主模型 | 独立 review_model 会被覆盖；有官方快照可还原；与自动审批复核模型不同 | CF applyCodexRelayConfig；cli-model-defaults |
| C10 | 推理强度 | 新建/reset 默认 xhigh，merge 不改 | 成本/延迟取舍，具体供应商模型支持须验证 | CF buildCodexRelayConfigTemplate |
| C11 | 认证源 | 中转使用 API Key auth.json；官方 token 独立快照 | 不伪造官方身份；API Key 本身的云端/连接器差异不是开关修复能解决 | CF buildCodexApiKeyAuth / createCodexRelayAuthPlans |
| C12 | 凭据读取位置 | merge 将显式 keyring/auto/ephemeral 改为 file | 防旧官方凭据抢优先；有快照可恢复，无快照未自动撤销 | CF applyCodexRelayConfig |
| C13 | 模型目录 | 固定官方资料与账号可用名单交集，写受管 model_catalog_json | 自定义目录保留；官方/过旧 runtime 撤受管路径；未知版本不盲改；目录替换而非自动合并新上游模型 | codex-model-catalog / CF createCodexRelayConfigPlans |
| C14 | 模型元数据 false | 官方文件中的 include_skills/apps/plugin_usage_instructions 等 | 字节来源与固定上游一致，消费者控制通用提示说明；不是关闭技能、插件注册或安装 | bundled-catalog/codex-models/models.json；上游 consumers 见总报告来源 |
| C15 | 上下文与压缩阈值 | 启动迁移删两个顶层有效键，活动/两类快照均处理，不判原值来源 | 有 .bak；profiles 嵌套保留；用户自定义值也会被删 | codex-config-migration / codex-context-limits；F04 |
| C16 | 废弃键 | 仅精确删除旧模板顶层 disable_response_storage=true、network_access=enabled、windows_wsl_setup_acknowledged=true | 其他值和嵌套保留；固定 v0.160 schema 无这些字段；不是关闭当前联网 | CF dropDeprecatedCodexConfigKeys |
| C17 | 完成通知 | 有受管脚本时补 notify；用户别的 notify 保留 | 切官方/卸载只撤自己可识别的命令 | cli-hooks applyCodexCliNotify / removeCodexCliNotify |
| C18 | 插件/MCP/普通偏好 | 官方/中转整份配置快照切换 | 本模式新配置不会自动进入另一旧快照；文件实体不删，原生 UI 状态未实测 | CF createCodexRelayConfigPlans / createCodexOfficialConfigPlans；F06 |
| C19 | 用户配置根 | 有效绝对 CODEX_HOME 被尊重；非法相对/NUL忽略并记录 | 开发 override 在正式包无效；还需对账原生实际 root | codex-home resolveCodexHomeContext |

## B. Claude Code

| ID | 设置/能力 | 写入与用户值规则 | 官方切换/卸载与影响 | 证据位置 |
| --- | --- | --- | --- | --- |
| CL01 | CLI 及插件自动更新 | DISABLE_AUTOUPDATER=1：新建/reset/merge；补缺只填缺省 | 官方 merge 保留、reset 仍写；卸载不撤；联带市场插件停更，command 来源例外 | CF disableClaudeSelfUpdate；[官方插件更新](https://code.claude.com/docs/en/plugins/org#turn-updates-off-for-the-whole-fleet)；F02 |
| CL02 | Artifact/DesignSync 工具 | 追加 permissions.deny，保留其它 deny | 官方删同名项，不区分用户先前值；卸载保留 | CF denyClaudeRelayTool / allowClaudeRelayTool；F03 |
| CL03 | WebFetch 域名预检 | skipWebFetchPreflight=true：新建/reset/merge；补缺保留已有 | 官方删除，不恢复旧 false；只是预检，WebFetch 没被禁用 | CF skipClaudeWebFetchPreflight；F03 |
| CL04 | 权限模式与告知 | 初始/reset 写 bypassPermissions、skipDangerousModePermissionPrompt=true | merge/补缺不补；官方 merge 残留，官方 reset 不写；属于权限行为 | CF createPlans / createOfficialAccountPlans；F08 |
| CL05 | 推理强度 | 初始/reset effortLevel=medium | merge 保留原选择；官方 merge 保留 | CF createPlans |
| CL06 | 模型、Key、端点 | 保存中转替换所选 model、AUTH_TOKEN、BASE_URL | 官方撤中转值；不是证明每个云端能力均可用 | CF createPlans / createMergePlans |
| CL07 | 模型菜单 | 有可用列表时生成最多20个Claude项，replaceBuiltInOptions=true；Default指向所选项 | 用户自定义菜单保留；官方按形状撤受管菜单，Default环境键直接删 | claude-model-picker build/restore；CF createMergePlans |
| CL08 | 外来 Key/模型别名/helper | 将 API_KEY、MODEL、SMALL_FAST、各子模型别名、SUBAGENT_MODEL、apiKeyHelper 暂存或移除 | 官方恢复快照，尊重之后新增同名值；卸载不自动恢复 | CF moveClaudeForeignSettingsAside / restoreClaudeForeignSettings |
| CL09 | Console Key | 暂存 primaryApiKey，避免抢认证 | 官方恢复；不表示清除全部 Claude 登录 | CF moveClaudeConsoleKeyAside / restoreClaudeConsoleKey |
| CL10 | 回答语言 | 初始/reset 简体中文，merge/补缺只填缺省 | 官方/卸载保留；这是CLI回答偏好，不是ChatGPT桌面UI开关 | CF ensureClaudeResponseLanguage |
| CL11 | 历史保留期 | cleanupPeriodDays=365，仅缺省补 | 用户已有值保留；官方/卸载保留；不是禁历史 | CF extendClaudeSessionRetention |
| CL12 | 工作区信任/首启向导 | 从星芒打开合规所选目录，缺省 hasTrustDialogAccepted、hasCompletedOnboarding | 已有明确 true/false 保留；不自动撤回 | CF trustClaudeWorkspace；SS launchProviderOperation |
| CL13 | 状态行 | 缺省或原星芒命令时写星芒状态行 | 用户其它命令保留；卸载移除受管命令，切官方不普遍撤销 | claude-status-line；CF removeManagedCliHooks |

## C. Gemini CLI

| ID | 设置/能力 | 写入与用户值规则 | 官方切换/卸载与影响 | 证据位置 |
| --- | --- | --- | --- | --- |
| GE01 | 自更新及提醒 | general.enableAutoUpdate=false、enableAutoUpdateNotification=false；merge强制，补缺只补 | 官方 merge保留、reset仍写；卸载不撤 | CF disableGeminiSelfUpdate |
| GE02 | 使用统计 | privacy.usageStatisticsEnabled=false；merge/补缺保留已有布尔 | 官方按单键false形状删除，用户false也可能被删 | CF disableGeminiRelayUsageStatistics / restoreGeminiUsageStatistics；F03 |
| GE03 | 认证与.env | 保存 API Key 认证及base/key/model；其它.env通常保留 | 官方 merge切oauth-personal并删中转键；显式官方reset重建.env | CF createPlans / createMergePlans / createOfficialAccountPlans |
| GE04 | 后台辅助模型 | 12类模型选择规则映射到当前中转模型 | 用户增加条件/参数的规则保留；同形规则按星芒处理，来源仍有歧义 | CF applyGeminiRelayModelOverrides / removeGeminiRelayModelOverrides |
| GE05 | 模型名兼容 | 部分flash型号追加-high | 路由兼容，不是关闭功能；实际效果依供应商 | CF geminiCliCompatibleModel |
| GE06 | IDE 集成 | 初始/reset ide.enabled=true | merge/补缺不动；官方merge保留 | CF createPlans |
| GE07 | 历史保留期 | 只有整段sessionRetention不存在才补maxAge=365d | 有现有段任意内容均保留；官方保留 | CF extendGeminiSessionRetention |
| GE08 | 工作目录信任 | 星芒打开所选目录时缺省写TRUST_FOLDER | 已有DO_NOT_TRUST等任意条目保留；不自动撤回 | CF trustGeminiWorkspace |
| GE09 | 项目说明文件 | 启动追加GEMINI.md与AGENTS.md | 其它文件名保留；空数组也追加；不自动撤回 | CF ensureGeminiProjectContextFiles |
| GE10 | 首页切官方入口 | 首页一键切来源列表不含Gemini | 配置页仍有入口；只是星芒UI，未证明整个官方登录关闭 | renderer-v2/features/tools/model.ts |

## D. Grok CLI

| ID | 设置/能力 | 写入与用户值规则 | 官方切换/卸载与影响 | 证据位置 |
| --- | --- | --- | --- | --- |
| GR01 | 自更新 | cli.auto_update=false，reset/merge强制，补缺仅缺省 | 官方merge也强制、reset也写；卸载不撤 | CF disableGrokSelfUpdate |
| GR02 | 模型菜单 | 缺省allowed_models=[当前型号] | 已有名单保留；官方移除已删中转模型引用 | CF pinGrokModelsToRelay / removeGrokRelayConfig |
| GR03 | 模型角色与能力 | default/web_search/session_summary/image_description路由中转；新受管模型声明responses、1000000上下文、backend search | merge对已有角色/能力有保留规则；官方移除中转表和相关选择器；实际后端能力仍须测试 | CF addManagedGrokModel / pinGrokModelsToRelay |
| GR04 | 图片/视频端点 | 保存强制xai_api_base_url为中转/v1，补缺尊重已有 | 官方仅当相同中转值时删；写入不证明媒体接口能用 | CF pointGrokXaiApiAtRelay |
| GR05 | Claude hooks兼容 | compat.claude.hooks=false，仅缺省写 | 官方/卸载仍保留；防止误执行Claude钩子，不是关闭Grok原生hooks | cli-hooks applyGrokCliHooks |

## E. 托管 MCP、Skill、Plugin 与通知

| ID | 项目 | 行为与边界 | 恢复/建议 | 证据 |
| --- | --- | --- | --- | --- |
| E01 | 星芒完成提醒/防睡hooks | 添加自己的事件命令，保留用户其它hooks；缺运行时/不安全路径可能不写 | 官方/卸载只清受管项；Grok不确定shell时撤自己的钩子 | cli-hooks apply/remove 函数 |
| E02 | 星芒画图MCP服务定义 | 同名非受管服务保持；确认受管后整条重建 | Codex/Grok enabled=false保留；其它用户字段可能丢失 | xingmang-ai-mcp applyXingmangImageMcpToToml/Json |
| E03 | Codex画图工具确认 | 受管generate_image固定approval_mode=approve | 会覆盖prompt并丢disabled_tools；保留用户工具级设置 | F05，根代理3场景fixture |
| E04 | Gemini画图服务确认 | 受管服务trust=true | 会覆盖false、丢include/exclude等字段；改为字段级维护 | F05，三CLI fixture |
| E05 | Claude画图工具许可 | 追加该工具allow | 已有针对本服务deny/ask时不追加；不同于E03/E04 | applyXingmangImagePermissionToClaudeSettings |
| E06 | Codex星芒AI Skill开关 | 官方模式false，中转模式true | 账号派生true会覆盖用户手动false；应拆账户可用与用户选择 | F07；SS applyXingmangAiSkillForCodexAccount |
| E07 | 全部扩展列表 | 读取异常时capabilities.kind.list=false，显示原因 | 不写外部配置；错误状态不应误报“没有任何插件” | ProviderExtensionService.list |
| E08 | 扩展操作能力表 | 不同工具/类型的安装、启停、更新入口不同 | 例如通用Codex插件表不提供启停/更新，但专用Codex服务有setPluginEnabled；不是底层功能总禁用 | nativeOperations；CodexExtensionService |
| E09 | 精选推荐过滤 | 只推荐满足当前入库标准的条目；现有插件精选只有Claude | 是推荐范围，不是禁止手动装其他源；不要以精选数量替代官方市场数量 | docs/CURATED-EXTENSIONS.md、curated-extensions registry |
| E10 | 官方Codex目录补偿 | 仅缺失/不完整时下载官方快照，完整则保留 | 没有看到改清单过滤官方插件；API身份/云端连接是独立限制 | codex-plugin-catalog；见PR #814相关方案 |

## F. 桌面客户端

| ID | 对象/设置 | 行为与原值处理 | 用户可见影响及边界 | 证据 |
| --- | --- | --- | --- | --- |
| D01 | Claude Desktop模型名单 | 保存星芒配置强制inferenceModels=[选中一个] | 覆盖自动发现；目前属于已知兼容收窄，恢复多模型须Win/Mac真机验证 | SS configureExternalTool → createClaudeDesktopConfigService().saveGateway |
| D02 | Claude Desktop模式 | deploymentMode=3p、静态gateway/Key | 使用第三方本地模式；上游身份/历史/发布节奏差异不是星芒批量关Chat/Cowork/Code | claude-desktop-config build计划；[官方说明](https://claude.com/docs/third-party/claude-desktop/overview) |
| D03 | Claude受管配置动态来源 | 重新保存删除configLibrary/_meta.json的当前hybridPointer；bootstrap/selfHosted/helper/oidc等在星芒所属UUID配置中删除 | 会重新选择当前静态配置，也覆盖用户后来加到该条目的动态来源；不是删除全机SSO/MDM | claude-desktop-config |
| D04 | Claude开发菜单 | 写allowDevTools=true | 主动开启；用户关false后星芒保存可再次开，应说明 | claude-desktop-config |
| D05 | Claude企业禁更新等策略 | 只读registry/MDM检测 | 没有写入disableAutoUpdates；不能与Claude Code自更新开关混同 | claude-desktop-policy |
| D06 | Codex自定义端点启动 | 星芒仅代启动relay/official来源 | 拒绝其它端点仅限星芒入口，原生快捷方式不受此函数限制 | CF canLaunchManagedProvider；desktop service |
| D07 | Codex中文 | 语言偏好可持久；Win补丁需用户opt-in并经星芒启动 | 仅改中文相关config ID和navigator，不改所有gate；Mac无该CDP路径；原生直启不继承补丁 | system-service、codex-desktop-locale/cdp |
| D08 | Codex权限UI旧状态 | 修复旧布尔/损坏结构，保留有效选择 | 让权限选项可见，不等于把实际模式设为全权限 | codex-desktop-state |
| D09 | Mac管理能力 | 支持安装/打开；星芒重启、卸载能力有限；Linux入口改荐CLI | 是管理器功能覆盖差异，不是关闭外部客户端相应功能 | platform-capabilities、desktop service、registry/tools |
| D10 | WorkBuddy | 保存选定模型，保留其它模型/未知字段；已有白名单补所选模型 | 未看到禁插件/更新/遥测的通用写入 | external-tool-config |
| D11 | OpenCode Desktop | 设星芒默认模型，保留其它provider；所选项从disabled/blacklist移出并加入已有允许名单 | 主动启用所选项，不是禁止其它provider；用户项目设置可另覆盖 | external-tool-config |

## G. 启动、环境、网络与管理器自身

以下是作用域审计。安全净化不是待批量撤销的功能关闭。

| ID | 策略 | 作用域/用户值 | 影响和恢复边界 | 证据 |
| --- | --- | --- | --- | --- |
| N01 | 提权环境禁止项与可信PATH | 仅跨完整性边界/可信执行路径 | 防注入变量和可执行文件劫持；不能放开以兼容用户profile | command-runner trustedCommandEnvironment、Windows解析器 |
| N02 | 普通终端环境 | 补常见Node/CLI路径；交互颜色层独立 | 普通同用户环境与提权环境不同；不能替换成同一严格白名单 | commandEnvironment、interactiveTerminalEnvironment |
| N03 | shell profile | 受管PowerShell使用-NoProfile、Mac生成脚本使用zsh -f | 受管脚本自身避免重新加载启动配置；Terminal/父shell已继承的环境需另行核验，不能概括为完全没有用户profile影响 | Win/Mac terminal启动计划 |
| N04 | 固定颜色/系统CA | 交互环境叠加颜色；普通Node工具使用系统证书信任 | 改的是启动环境，不是持久关渲染功能或跳过TLS验证 | system-service、macos-platform、linux-terminal |
| N05 | Gemini残留身份变量 | 星芒启动环境清理覆盖当前账号的变量，再按托管配置注入 | 限该子进程；不能宣称修改系统环境或用户终端已修复 | providerCommandEnvironment / Gemini专用环境构建 |
| N06 | Codex --no-daemon | 已识别支持版本的交互CLI全局参数 | 不传给所有native桌面入口；不等于禁所有后台/子代理 | cliLaunchArgv |
| N07 | Windows/Mac CODEX_HOME | Win AppModel未显式传已解析root；Mac open --env明确传新进程 | 直接原生入口、已运行实例环境可能不同；不是关闭账号功能 | codex-desktop-service / macos-codex-app |
| N08 | 调试端口 | Windows中文兼容由明确opt-in启用 | 端口随进程存在；原生直启不带，不应默认扩大到其它feature | codex-desktop-cdp、chinese-runtime-choice |
| N09 | 宕掉本机代理绕过 | 只在证据支持本机端口失效时，不让当前请求继续卡死 | 按不同network stack分别处理；不是删用户全局代理配置 | stale-proxy-environment / proxy-bypass |
| N10 | 站点直连兜底 | 星芒站点请求可以切专用直连session | 不应泛化为所有GitHub/插件/官方域名也直连；每种下载consumer需单独核对 | main createSiteRouting 接线 |
| N11 | 下载专用加速 | lease只影响星芒下载session，借用后释放 | 不改系统代理，不自动作用于官方native进程或任意CLI | download-acceleration / main |
| N12 | Codex自动系统加速 | relay模式约两次启动存活确认后收回；官方账号路径按退出等条件收回 | 稍后官方请求/插件下载失去该线路；用户自开线路按所有权保护 | codex-desktop-acceleration / acceleration-service |
| N13 | 子进程代理 | 只向支持的子进程传已验证回环proxy，远端/PAC fallback不直接下发 | 是信任边界和实现范围，不能因浏览器可用就断言CLI同路径 | download-proxy subprocessDownloadProxyEnvironment |
| N14 | 工作区覆盖诊断 | 检测项目/企业配置可能盖过当前账号 | 只读发现，不擅改公司策略；不要误报星芒主动禁用 | workspace-config-overrides |
| N15 | 永久清理失效代理变量 | 用户专用动作重新核对后删除Windows User scope的closed变量 | 不是启动自动清理；Machine不动，可能显露Machine值；当前没有自动撤销备份 | clearStaleUserProxyVariables、IPC专用动作 |
| N16 | 系统代理临时替换和恢复 | 保存原值，替换受管HTTP/HTTPS/PAC等字段 | Win为WinInet、Mac为Ethernet/Wi-Fi；后续用户修改受保护，恢复失败保留记录/内核；不是永久接管全部网络 | acceleration backend与Win/Mac system-proxy实现 |
| N17 | 自动加速会话展示 | 自动会话在游戏页/托盘隐藏，用户和自动会话分别管理所有权 | 界面未显示不等于系统代理没开；用户接管与自动停止有不同条件 | acceleration-service userAccelerationState/createUserAccelerationApi |
| N18 | 加速内核能力 | 固定回环listener，TUN/DNS/sniffer关闭，不继承用户Clash配置；已有HTTP/PAC冲突，WPAD有单独取舍 | 是受控通道范围，不是关闭操作系统VPN或全机网络 | acceleration-conflict、acceleration-clash-config、mihomo runtime |
| A01 | 星芒自身更新/通知 | 缺省开启；用户明确false才存 | 与CLI自更新不同；开发包、签名/平台限制另决定更新能力 | app-settings、main、updater |
| A02 | 星芒GPU加速 | 缺省开启，用户false或崩溃兼容降级可关 | 仅管理器图形呈现；需要重开，不影响官方模型功能 | display-compat、main |
| A03 | 启动自动诊断 | 缺省false | 不自动扫描不是诊断功能不可用；用户可主动检查 | defaultAppSettings |
| A04 | 发布包与平台安全能力 | fuses、沙箱、来源/签名、网络白名单、Linux拒root | 保护边界；未把这些列为“应恢复的功能” | electron-builder、platform-capabilities及安全模块 |
| A05 | 星芒崩溃报告 | 用户配置及XINGMANG_DISABLE_CRASH_REPORTING可以停用本应用报告 | 与Codex analytics不是同一项；不因此推断会影响官方客户端Statsig缓存 | crash-report、main、app-settings |

网络组合问题见总报告 F10；上表 N 项只陈述各自的策略作用域，不能用单个模块单测证明所有组合正确。

## H. 如何使用这份清单

1. 先看操作类型，避免将用户显式 reset 的重建与自动补缺覆盖混为一谈。
2. 对“关闭”同时记录管理器UI、外部配置、启动进程、上游身份四个层次，不能互相代替。
3. 切官方和卸载不是同一个恢复入口；当前很多版本治理、语言、保留期和兼容设置会继续存在。
4. 修改任何策略前补对应的原值/用户改值/失败回滚验证，尤其保护隐私false、deny、MCP工具范围和账号凭据。
5. 此表限定固定版本。新上游字段、模型和插件不得直接复用旧结论，静态false也不能自动解释为功能被禁止。
