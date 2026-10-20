import type { ipcInvokeChannels } from './ipc-contract'

/**
 * 主窗口业务通道每一条在日志里记什么、要不要等账号（#1071 第 1 条）。以前是 ipc.ts 里几串按名字写的
 * 字符串集合和一长串 startsWith，名字拼错、新通道漏加都不报错，脱敏和账号校验会悄悄失效。现在键是
 * 契约里的通道名，漏一条、多一条、拼错一条都是编译错；log 和 account 两项必填，加通道时得想清楚。
 */

export type IpcInvokeChannel = (typeof ipcInvokeChannels)[keyof typeof ipcInvokeChannels]

/**
 * 这条通道在运行日志里记什么（I13）。成功那一行只交给 ipc/handler-log.ts 的两个格式化函数（ipcSuccessMessage、
 * ipcLogDetail），它们只挑固定字段，不整个摊开入参和结果；下面几种是在那之上再收紧。
 *
 * - normal：成功、失败都记。
 * - quiet-success：成功不记，失败照记。结果或入参带明文密钥、密码、个人信息的（I3），或者太频繁、
 *   记了只会刷屏的读取，放这里。
 * - secret-input：入参本身是秘密，但成功了还值得记一行。记成功时交给格式化函数的入参是空的，
 *   入参从构造上就进不了日志，不靠每个格式化函数都恰好不碰它。
 * - silent：成功、失败都不在这里记。
 * - polling：公告、公告已读同步、订阅这三样，登录后每隔几分钟自己读一次。每次成功都记一条 info
 *   的话，电脑开几天不关，反馈报告附的最近 600 条里就几乎只剩它们（第二十六批 B：一份 Mac 报告里
 *   三样一共占了 508 条，耗时中位 12 毫秒）。成功降到调试级：照样落盘，只是报告不附，要数一共成功
 *   几次去看本机日志文件。有两种成功照记 info，排查要用：慢的，报告里一眼看得出线路慢不慢；上一次
 *   失败之后的第一次成功，看得出什么时候恢复的。失败照旧一律记 error。已读同步除了跟着公告刷新，
 *   客户点开一条公告时也走它；那一下成功了同样不必进报告，没成功照样记 error。
 */
export type IpcLogPolicy = 'normal' | 'quiet-success' | 'secret-input' | 'silent' | 'polling'

/**
 * 这条通道跟当前账号的关系。带 scoped 的三种：开机恢复账号没完成就先等它（options.realmAccounts 在时）。
 *
 * - none：跟账号无关；或者是登录、注册、退出、读登录态、切换已存账号这类本身就在管登录的通道，
 *   不进账号工作，要不要等开机恢复由处理函数自己定。
 * - scoped：在账号工作里跑，换账号要等它跑完才动手；跑完时账号已经换了，结果作废，报「账号上下文已变化，请重试」。
 * - scoped-may-end-session：同上，但这一下自己就可能结束或换掉登录（改密码、踢掉当前这台设备），
 *   跑完不核对账号换没换。
 * - scoped-queued：要在安装队列里排在别的安装后面（I11）。排着队那段不算账号工作，处理函数交给队列时
 *   才拿 accountWork.queue()，轮到它执行才算进去（#1085）；开机照旧先等账号恢复完。
 */
export type IpcAccountPolicy = 'none' | 'scoped' | 'scoped-may-end-session' | 'scoped-queued'

export interface IpcChannelPolicy {
  /** 日志里这条操作的中文名；没有就显示通道名。 */
  label?: string
  log: IpcLogPolicy
  account: IpcAccountPolicy
}

export const ipcChannelPolicies: Readonly<Record<IpcInvokeChannel, IpcChannelPolicy>> = {
  'platform:get-capabilities': { log: 'normal', account: 'none' },
  'system:scan': { label: '本机环境与 AI 工具检测', log: 'quiet-success', account: 'none' },
  'system:refresh-network-location': { label: '当前网络位置刷新', log: 'quiet-success', account: 'none' },
  'system:refresh-official-chatgpt': { log: 'normal', account: 'none' },
  'startup:codex-readiness': { label: 'Codex 启动状态检测', log: 'quiet-success', account: 'none' },
  'config:get': { label: '工具配置读取', log: 'quiet-success', account: 'scoped' },
  // The result is the plaintext CLI key -- one of the dedicated reveal
  // channels registered under I3; its success must never reach the log (I13).
  'config:reveal-api-key': { label: 'API Key 明文读取', log: 'quiet-success', account: 'scoped' },
  'config:save': { label: '工具配置保存', log: 'normal', account: 'scoped' },
  'config:open-directory': { label: '工具配置目录打开', log: 'normal', account: 'scoped' },
  'config:configure-external-tool': { log: 'normal', account: 'scoped' },
  // 开机先摆上次结果的那一读（第二个参数 cachedOnly: true）只读本机一个文件，不等账号；
  // 这一项按入参判断，在 ipc/handler-log.ts 的 readsCachedExternalClientsOnly，不在这张表里。
  'external-clients:scan': { label: '外部客户端检测', log: 'normal', account: 'scoped' },
  'external-clients:install': { label: '外部客户端安装', log: 'normal', account: 'none' },
  'external-clients:cancel-install': { label: '外部客户端安装取消', log: 'normal', account: 'none' },
  'external-clients:launch': { label: '外部客户端启动', log: 'normal', account: 'scoped' },
  'external-clients:switch-source': { label: '外部客户端账号切换', log: 'normal', account: 'scoped' },
  'config:switch-to-official-account': { log: 'normal', account: 'scoped' },
  'config:switch-account-source': { log: 'normal', account: 'scoped' },
  'config:repair-cli-hooks': { log: 'normal', account: 'scoped' },
  'tools:inspect-running': { label: '换账号后检查哪些工具还开着', log: 'normal', account: 'none' },
  'tools:check-models': { label: '打开工具前核对当前账号能用的模型', log: 'normal', account: 'scoped' },
  'tools:cli-model-hints': { label: '读取服务状态文件里的型号表', log: 'normal', account: 'none' },
  'config:fill-template-defaults': { label: '给工具配置补齐新版设置', log: 'normal', account: 'scoped' },
  'workspace:choose': { label: '工作目录选择', log: 'normal', account: 'none' },
  'repository:get-context': { label: '仓库上下文读取', log: 'quiet-success', account: 'none' },
  'runtime:install-node': { label: 'Node.js LTS 自动安装', log: 'normal', account: 'none' },
  'runtime:restart-windows': { log: 'normal', account: 'none' },
  'runtime:install-python': { label: 'Python 3.12 自动安装', log: 'normal', account: 'none' },
  'runtime:install-git': { log: 'normal', account: 'none' },
  'cli:install': { label: 'CLI 安装或更新', log: 'normal', account: 'none' },
  'cli:cancel-install': { log: 'normal', account: 'none' },
  'cli:uninstall': { label: 'CLI 卸载', log: 'normal', account: 'none' },
  'cli:clean-uninstall-leftovers': { label: 'CLI 卸载残留清理', log: 'normal', account: 'none' },
  'cli:check-update': { label: 'CLI 单项更新检查', log: 'normal', account: 'none' },
  'setup:codex-status': { label: 'Codex 初始化状态检测', log: 'quiet-success', account: 'none' },
  'desktop:install-codex': { label: 'Codex 桌面端安装', log: 'normal', account: 'none' },
  'desktop:cancel-install-codex': { log: 'normal', account: 'none' },
  'desktop:uninstall-codex': { label: 'Codex 桌面端卸载', log: 'normal', account: 'none' },
  'desktop:reset-codex': { label: 'Codex 桌面端重置', log: 'normal', account: 'none' },
  'desktop:check-update-codex': { label: 'Codex 桌面端更新检查', log: 'normal', account: 'none' },
  'cli:launch': { label: 'CLI 终端启动', log: 'normal', account: 'scoped-queued' },
  'desktop:codex-status': { label: 'Codex 桌面端运行状态检测', log: 'quiet-success', account: 'none' },
  'desktop:codex-locale-status': { label: 'Codex Desktop 中文资源检测', log: 'quiet-success', account: 'none' },
  'desktop:codex-permissions-status': { label: 'Codex Desktop 工作区权限检测', log: 'quiet-success', account: 'none' },
  'desktop:trust-workspace': { label: 'Codex Desktop 工作区信任设置', log: 'normal', account: 'none' },
  'desktop:set-codex-locale': { label: 'Codex Desktop 语言设置', log: 'normal', account: 'none' },
  'desktop:launch-codex': { label: 'Codex 桌面端启动', log: 'normal', account: 'scoped-queued' },
  'models:list': { label: '可用模型读取', log: 'normal', account: 'scoped' },
  'models:list-configured': { label: '已配置 CLI 可用模型读取', log: 'normal', account: 'scoped' },
  'window:set-mode': { label: '窗口模式切换', log: 'quiet-success', account: 'none' },
  'window:set-theme': { label: '界面主题切换', log: 'quiet-success', account: 'none' },
  'window:get-capabilities': { log: 'normal', account: 'none' },
  'window:relaunch': { log: 'normal', account: 'none' },
  'window:uninstall-app': { log: 'normal', account: 'none' },
  'navigation:take-deep-link': { log: 'normal', account: 'none' },
  'external:open': { label: '外部链接打开', log: 'normal', account: 'none' },
  'network:bypass-broken-proxy': { label: '代理连不上时改走直连', log: 'normal', account: 'none' },
  'network:open-settings': { label: '打开系统网络设置', log: 'normal', account: 'none' },
  'update:get-state': { label: '主程序更新状态读取', log: 'quiet-success', account: 'none' },
  'update:startup': { label: '主程序启动更新', log: 'quiet-success', account: 'none' },
  'update:check': { label: '主程序更新检查', log: 'normal', account: 'none' },
  'update:download': { label: '主程序更新下载', log: 'normal', account: 'none' },
  'update:install': { label: '主程序更新安装', log: 'normal', account: 'none' },
  'sessions:list': { label: 'Codex 会话列表读取', log: 'normal', account: 'none' },
  'sessions:detail': { label: 'Codex 会话详情读取', log: 'normal', account: 'none' },
  'sessions:export': { label: 'Codex 会话导出', log: 'normal', account: 'none' },
  'sessions:archive': { label: 'Codex 会话归档', log: 'normal', account: 'none' },
  'sessions:restore': { label: 'Codex 会话恢复', log: 'normal', account: 'none' },
  'provider-sessions:list': { label: 'AI 工具会话列表读取', log: 'normal', account: 'none' },
  'provider-sessions:detail': { label: 'AI 工具会话详情读取', log: 'normal', account: 'none' },
  'provider-sessions:export': { label: 'AI 工具会话导出', log: 'normal', account: 'none' },
  'provider-sessions:open-directory': { label: 'AI 工具会话工作目录打开', log: 'normal', account: 'none' },
  'provider-sessions:delete': { label: 'AI 工具会话彻底删除', log: 'normal', account: 'none' },
  'settings:get': { label: '应用设置读取', log: 'quiet-success', account: 'none' },
  'settings:save': { label: '应用设置保存', log: 'normal', account: 'none' },
  'diagnostics:run': { label: '系统诊断', log: 'normal', account: 'none' },
  'diagnostics:export': { label: '诊断报告导出', log: 'normal', account: 'none' },
  'runtime-logs:list': { label: '运行日志读取', log: 'quiet-success', account: 'none' },
  'runtime-logs:preview-feedback': { log: 'normal', account: 'none' },
  'runtime-logs:copy-feedback': { label: '脱敏反馈文本复制', log: 'normal', account: 'none' },
  'runtime-logs:export-feedback': { label: '反馈报告导出', log: 'normal', account: 'none' },
  'exports:reveal-file': { label: '导出文件定位', log: 'normal', account: 'none' },
  'runtime-logs:open-directory': { label: '日志目录打开', log: 'normal', account: 'none' },
  'runtime-logs:clear': { label: '运行日志清空', log: 'normal', account: 'none' },
  'runtime-logs:renderer-error': { label: '渲染进程异常上报', log: 'quiet-success', account: 'none' },
  'backups:list': { label: '配置备份列表读取', log: 'normal', account: 'none' },
  'backups:create': { label: '配置备份创建', log: 'normal', account: 'none' },
  'backups:inspect': { label: '配置备份详情读取', log: 'normal', account: 'none' },
  'backups:restore': { label: '配置备份恢复', log: 'normal', account: 'none' },
  'backups:delete': { label: '配置备份删除', log: 'normal', account: 'none' },
  'mcp:list': { label: 'MCP 列表读取', log: 'normal', account: 'none' },
  'mcp:add': { label: 'MCP 添加', log: 'normal', account: 'none' },
  'mcp:remove': { label: 'MCP 删除', log: 'normal', account: 'none' },
  'mcp:login': { label: 'MCP 登录', log: 'normal', account: 'none' },
  'mcp:cancel-login': { label: '取消 MCP 登录', log: 'normal', account: 'none' },
  'mcp:logout': { label: 'MCP 退出登录', log: 'normal', account: 'none' },
  'skills:list': { label: 'Skills 列表读取', log: 'normal', account: 'none' },
  'skills:import': { label: 'Skill 导入', log: 'normal', account: 'none' },
  'skills:toggle': { label: 'Skill 启用状态修改', log: 'normal', account: 'none' },
  'skills:uninstall': { label: 'Skill 卸载', log: 'normal', account: 'none' },
  'plugins:list': { label: 'Plugins 列表读取', log: 'normal', account: 'none' },
  'plugins:add': { label: 'Plugin 安装', log: 'normal', account: 'none' },
  'plugins:remove': { label: 'Plugin 卸载', log: 'normal', account: 'none' },
  'plugins:toggle': { label: 'Plugin 启用状态修改', log: 'normal', account: 'none' },
  'marketplaces:add': { label: '扩展市场添加', log: 'normal', account: 'none' },
  'marketplaces:upgrade': { label: '扩展市场更新', log: 'normal', account: 'none' },
  'marketplaces:remove': { label: '扩展市场删除', log: 'normal', account: 'none' },
  'extensions:list': { label: 'AI 工具扩展列表读取', log: 'normal', account: 'none' },
  'extensions:list-all': { label: '全部 AI 工具扩展读取', log: 'normal', account: 'none' },
  'extensions:mutate': { label: 'AI 工具扩展操作', log: 'normal', account: 'none' },
  'extensions:ensure-marketplace': { label: '官方插件市场添加', log: 'normal', account: 'none' },
  'extensions:check-mcp-health': { label: 'MCP 连接状态检测', log: 'normal', account: 'none' },
  // Frequent read-style checks stay quiet, while managed CLI configuration
  // handles secrets internally and account:reveal-key deliberately returns a
  // short-lived plaintext secret to the renderer. Logging any of those
  // success details risks putting account data or a CLI key on disk (I3/I13).
  // The same reason covers the other quiet-success account:* reads below
  // (get-legal-document, get-session, get-balance, sync-managed-cli-keys,
  // configure-managed-clis, reveal-key, list-key-models, configure-cli-with-key).
  'account:get-status': { label: '星芒账号服务状态读取', log: 'quiet-success', account: 'none' },
  'account:get-notice': { log: 'polling', account: 'scoped' },
  'account:mark-notice-read': { log: 'normal', account: 'scoped' },
  'account:sync-local-notice-reads': { log: 'polling', account: 'scoped' },
  'acceleration:get-state': { log: 'normal', account: 'none' },
  'acceleration:list-lines': { log: 'normal', account: 'none' },
  'acceleration:ping-line': { log: 'normal', account: 'none' },
  'acceleration:start': { log: 'normal', account: 'none' },
  'acceleration:stop': { log: 'normal', account: 'none' },
  'acceleration:redeem-code': { log: 'normal', account: 'none' },
  'acceleration:get-preference': { log: 'normal', account: 'none' },
  'acceleration:save-preference': { log: 'normal', account: 'none' },
  'acceleration:recheck-bundle': { log: 'normal', account: 'none' },
  'account:get-legal-document': { label: '星芒账号法律文档读取', log: 'quiet-success', account: 'none' },
  'account:login': { label: '星芒账号登录', log: 'normal', account: 'none' },
  // The two-factor code is a live one-time code (or a single-use backup code);
  // it used to be fully quiet, which left a 「我输了验证码还是登不上」 ticket
  // without even a sign of whether the second step went through (三线路 7b).
  'account:submit-two-factor-code': { label: '星芒账号两步验证登录', log: 'secret-input', account: 'none' },
  'account:logout': { label: '星芒账号退出登录', log: 'normal', account: 'none' },
  'account:get-session': { label: '星芒账号会话状态读取', log: 'quiet-success', account: 'none' },
  'account:list-saved': { log: 'normal', account: 'none' },
  'account:switch-saved': { log: 'normal', account: 'none' },
  'account:remove-saved': { log: 'normal', account: 'none' },
  'account:get-balance': { label: '星芒账号余额查询', log: 'quiet-success', account: 'scoped' },
  'account:get-topup-info': { log: 'normal', account: 'scoped' },
  'account:quote-topup': { log: 'normal', account: 'scoped' },
  'account:create-topup-payment': { log: 'normal', account: 'scoped' },
  'account:close-payment-window': { log: 'normal', account: 'scoped' },
  'account:list-topup-orders': { log: 'normal', account: 'scoped' },
  'account:redeem-topup-code': { log: 'normal', account: 'scoped' },
  'account:transfer-affiliate-quota': { log: 'normal', account: 'scoped' },
  'account:list-subscription-plans': { log: 'normal', account: 'scoped' },
  'account:get-subscription-self': { log: 'polling', account: 'scoped' },
  'account:update-subscription-preference': { log: 'normal', account: 'scoped' },
  'account:create-subscription-payment': { log: 'normal', account: 'scoped' },
  'account:purchase-subscription-balance': { log: 'normal', account: 'scoped' },
  'account:sync-managed-cli-keys': { label: '四组 CLI Key 初始化', log: 'quiet-success', account: 'scoped' },
  'account:configure-managed-clis': { label: '四组 CLI 配置写入', log: 'quiet-success', account: 'scoped' },
  'account:register': { label: '星芒账号注册', log: 'normal', account: 'none' },
  'account:send-verification-code': { label: '星芒账号邮箱验证码发送', log: 'normal', account: 'none' },
  'account:send-reset-code': { label: '星芒账号密码重置邮件发送', log: 'normal', account: 'none' },
  // account:reset-password's result carries a server-generated plaintext
  // password (NewApiResetPasswordResult) -- exactly as sensitive as the CLI
  // key above, same I3/I13 reasoning.
  'account:reset-password': { label: '星芒账号密码重置', log: 'quiet-success', account: 'none' },
  // get-profile's result carries email/aff_code -- PII, not a secret exactly,
  // but still not something that belongs in the plaintext runtime log
  // (I13). get-usage's result has its own `total` field, which
  // collectionSize() would otherwise surface into the log via itemCount; not
  // sensitive on its own, but grouped with get-dashboard/get-tasks for the
  // same "account:* reads stay quiet" consistency as get-status/get-session/
  // get-balance above.
  'account:get-profile': { label: '星芒账号资料读取', log: 'quiet-success', account: 'scoped' },
  'account:update-display-name': { log: 'normal', account: 'scoped' },
  'account:get-usage': { label: '星芒账号用量明细读取', log: 'quiet-success', account: 'scoped' },
  'account:get-dashboard': { label: '星芒账号数据看板读取', log: 'quiet-success', account: 'scoped' },
  'account:get-tasks': { label: '星芒账号任务日志读取', log: 'quiet-success', account: 'scoped' },
  // list-keys' DTO is metadata-only (I3 -- see NewApiAccountKey's own
  // comment for the whitelist), so nothing here is secret either; quiet, like
  // list-groups and copy-key, for the same "account:* reads stay quiet"
  // consistency as get-usage rather than being the one account:* read that
  // logs differently from its siblings.
  'account:list-keys': { label: '星芒账号 Key 列表读取', log: 'quiet-success', account: 'scoped' },
  'account:list-groups': { label: '星芒账号可用分组读取', log: 'quiet-success', account: 'scoped' },
  'account:revoke-key': { label: '星芒账号 Key 撤销', log: 'normal', account: 'scoped' },
  'account:copy-key': { label: '星芒账号 Key 复制', log: 'quiet-success', account: 'scoped' },
  // The input is the plaintext password the reset just produced.
  'account:copy-reset-password': { label: '找回密码后的新密码复制', log: 'quiet-success', account: 'none' },
  'account:reveal-key': { label: '星芒账号 Key 明文读取', log: 'quiet-success', account: 'scoped' },
  'account:list-key-models': { label: '星芒账号 Key 可用模型读取', log: 'quiet-success', account: 'scoped' },
  'account:configure-cli-with-key': { label: '星芒账号 Key 写入 CLI 配置', log: 'quiet-success', account: 'scoped' },
  // change-password's *input* carries two plaintext passwords (args[0], not
  // the result -- the result is just {changed:true}, I3-safe on its own).
  // ipcLogDetail/ipcSuccessMessage happen to never spread args[0] generically
  // today, but that is true by omission, not by contract -- quieting this
  // channel outright removes the need to keep re-verifying that invariant
  // every time either function gains a new per-channel branch (I13).
  'account:change-password': { label: '星芒账号密码修改', log: 'quiet-success', account: 'scoped-may-end-session' },
  'account:list-login-sessions': { log: 'normal', account: 'scoped' },
  'account:revoke-login-session': { log: 'normal', account: 'scoped-may-end-session' },
  'account:revoke-other-login-sessions': { log: 'normal', account: 'scoped' },
  'canvas:open': { label: '无限画布窗口打开', log: 'normal', account: 'scoped' },
  // get-remembered-login's result and set-remembered-login's input both carry
  // a plaintext password (the 「记住密码」 credential) -- the same dedicated
  // reveal-channel pattern as config:reveal-api-key, and the same I3/I13
  // reason to keep both fully out of the runtime log.
  'account:get-remembered-login': { label: '记住的登录凭据读取', log: 'quiet-success', account: 'none' },
  'account:set-remembered-login': { label: '记住的登录凭据更新', log: 'quiet-success', account: 'none' },
  'account:create-key': { label: '星芒账号 Key 创建', log: 'normal', account: 'scoped' },
  'account:update-key': { label: '星芒账号 Key 更新', log: 'normal', account: 'scoped' },
  'chat:list-groups': { log: 'quiet-success', account: 'scoped' },
  'chat:prepare-group': { log: 'silent', account: 'scoped' },
  'chat:start': { log: 'silent', account: 'scoped' },
  'chat:generate-image': { log: 'silent', account: 'scoped' },
  'chat:cancel': { log: 'quiet-success', account: 'scoped' },
  'chat:copy-asset': { log: 'quiet-success', account: 'scoped' },
  'chat:save-asset': { log: 'quiet-success', account: 'scoped' },
  'chat:asset-menu': { log: 'quiet-success', account: 'scoped' },
  'chat:pick-images': { label: '聊天图片选择', log: 'quiet-success', account: 'scoped' },
  'chat:paste-image': { label: '聊天截图粘贴', log: 'quiet-success', account: 'scoped' },
  // Chat history carries whole conversations and autosaves after every edit:
  // a success line would flood the log, and the payload must never reach it
  // (I13). Failures still log, with the Chinese reason only.
  'chat-history:read': { label: '聊天记录读取', log: 'quiet-success', account: 'none' },
  'chat-history:write': { label: '聊天记录保存', log: 'quiet-success', account: 'none' },
  'chat-history:export-text': { label: '聊天对话导出', log: 'normal', account: 'none' },
  'data-transfer:export': { label: '聊天记录与设置导出', log: 'normal', account: 'none' },
  'data-transfer:import': { label: '聊天记录与设置导入', log: 'normal', account: 'none' },
  'diagnostics:check-connection': { label: '连接自检', log: 'normal', account: 'none' },
  'diagnostics:probe-codex-responses': { label: 'Codex 干活检查', log: 'normal', account: 'none' },
  'diagnostics:check-external-connection': { label: '客户端连接自检', log: 'normal', account: 'none' },
  'account:get-key-options': { log: 'quiet-success', account: 'scoped' },
  'diagnostics:clear-stale-proxy': { label: '清掉旧的代理设置', log: 'normal', account: 'none' },
  'diagnostics:open-folder': { label: '检查页打开文件夹', log: 'normal', account: 'none' },
  'diagnostics:fix': { label: '检查页一键处理', log: 'normal', account: 'none' },
  'extensions:choose-directory': { label: '外接工具选择文件夹', log: 'normal', account: 'none' },
}
