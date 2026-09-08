# 22 · 注册表（页面 / 工具 / 图标 / 状态 / 错误）

这些表是**代码里的单一事实来源**。实现时做成 TypeScript 常量文件（`src/renderer-v2/registry/*.ts`），页面和组件只读表，不写死。

## 1. 页面注册表 `registry/pages.ts`

| id | 标签 | Lucide 图标 | 分组 | 模板 | 命令面板 | testid |
|---|---|---|---|---|---|---|
| home | 首页 | home | daily | T5 | 跳转 | page-home |
| chat | 聊天 | message-square | daily | 专用 | 跳转 | page-chat |
| sessions | 记录 | clock | daily | T3 | 跳转 | page-sessions |
| canvas | 画布 ↗ | infinity | daily | 独立窗口 | 跳转 | nav-canvas |
| mcp | 外接工具 | plug | extend | T1 | 跳转 | page-mcp |
| skills | 技能 | sparkles | extend | T1 | 跳转 | page-skills |
| plugins | 插件 | package | extend | T1 | 跳转 | page-plugins |
| tutorial | 教程 | book-open | maintain | 专用 | 跳转 | page-tutorial |
| health | 检查 | zap | maintain | 专用 | 跳转 | page-health |
| maintenance | 安装卸载 | wrench | maintain/more | 专用 | 跳转 | page-maintenance |
| backups | 备份 | archive | maintain/more | T1 | 跳转 | page-backups |
| feedback | 反馈 | flag | maintain/more | T1 | 跳转 | page-feedback |
| updates | 更新 | refresh-cw | maintain/more | 专用 | 跳转 | page-updates |
| settings | 设置 | settings | maintain | T2 | 跳转（⌘,） | page-settings |
| account | 个人中心 | user | 侧栏账号卡 | T2 | 跳转 | page-account |

## 2. 工具注册表 `registry/tools.ts`

```ts
type ToolDef = {
  id: 'claude' | 'codex' | 'codexDesktop' | 'gemini' | 'grok' | string
  name: string                      // 显示名，如 'Claude Code'
  vendor: string                    // 'Anthropic'
  brandIcon: string                 // '@lobehub/icons' 导出名：'Claude' | 'OpenAI' | 'Gemini' | 'Grok'
  kind: 'cli' | 'desktop'
  install: { type: 'npm'; pkg: string } | { type: 'installer'; win?: 'managed'|'store'; mac?: 'external'; linux?: 'unavailable' }
  requires: ('node' | 'python')[]
  configPath: Record<'win'|'mac'|'linux', string>   // '%USERPROFILE%\\.claude' 等
  keyWrite: 'settings-json' | 'toml' | 'env' | 'desktop-store'
  sources: ('account' | 'official' | 'manual')[]     // 支持的连接来源
  models?: string[] | { endpoint: string }           // 静态或检测接口
  shortcutIndex: number                              // ⌘1–5 位次
  hidden?: (os) => boolean                           // 如 codexDesktop 在 linux
}
```
派生规则（代码按表自动生成，不允许各页面各写一份）：首页工具列表顺序 = `shortcutIndex`；向导第一步选项 = 全部未 `hidden` 的工具 + 「先聊天」；配置弹窗页签 = 全部；外接工具 / 备份分段 = `kind === 'cli'` 的；托盘菜单 = 已安装的。

## 3. 图标语义表 `registry/icons.ts`

| 语义 | Lucide | 用在 |
|---|---|---|
| 打开 / 启动 | folder-open | 工具主按钮 |
| 安装 / 下载 | download | 安装按钮、更新下载 |
| 更新 / 刷新 / 重新检测 | refresh-cw | 更新按钮、刷新、重检 |
| 配置 / 设置 | settings | 配置弹窗、设置页 |
| Key | key | 密钥、写入 Key |
| 删除 / 卸载 / 撤销 / 清除 | trash-2 | 危险动作 |
| 更多操作 | ellipsis | `···` |
| 添加 | plus | 添加连接 / 导入 / 新建 |
| 搜索 | search | 搜索框、命令面板 |
| 关闭 | x | 弹窗 ×、通知 × |
| 完成 / 已读 | check | 成功态、标已读 |
| 提示 / 信息 | info | callout、告警条 |
| 警示 | alert-triangle | 失败弹窗标题 |
| 公告 | bell | 顶栏、公告条 |
| 帮助 / 客服 | circle-help | 顶栏帮助 |
| 客服微信 | message-circle | 客服弹窗 |
| 充值 / 能量 | zap | 充值按钮、检查页 |
| 备份 | archive | 备份页、备份配置 |
| 复制 | copy | 复制 Key / 报告 |
| 显示 / 隐藏 | eye / eye-off | 密码、Key 明文 |
| 编辑 | pencil | 编辑 Key / 消息 |
| 外链 | arrow-up-right | 画布 ↗、浏览器打开 |
| 教程 | book-open | 教程 |
| 反馈 | flag | 反馈 |
| 网络 | globe | 镜像、HTTP 连接 |
| 服务器 / 本地命令 | server | stdio 连接 |
| 设备 | monitor | 登录设备 |
| 用户 | user | 未登录头像、个人中心 |
| 侧栏收起 | panel-left | |
| 发送 / 停止 | arrow-up / square | 聊天 |
| 参数 | sliders-horizontal | 聊天参数 |
| 图片 / 视频 | image / video | 生成、画布节点 |

新增语义必须先加这里，同一语义永远同一图标。

## 4. 状态词表 `registry/status.ts`

| 领域 | 状态 id | 文字 | tone | 附加动作 |
|---|---|---|---|---|
| 工具 | missing | 未安装 | neutral | 安装 |
| 工具 | installing | 安装中 N% | accent | — |
| 工具 | updating | 更新中 N% | accent | — |
| 工具 | ready | 已配好 | ok | — |
| 工具 | official | 官方账号 | ok | — |
| 工具 | unconfigured | 还没配 Key | warn | 配 Key |
| 工具 | update | 可更新 | warn | 更新 |
| 工具 | keyRevoked | Key 失效 | bad | 修复 |
| 工具 | zeroBalance | 余额为零 | bad | 马上充值 |
| 工具 | unknownSource | 已有第三方配置 | neutral | 查看处理步骤 |
| 环境 | ok / missing / optional | 已找到 x / 未安装 / 可选 · 未装 | ok / warn / neutral | 一键安装 / 安装指南 |
| Key | active / disabled / expired / exhausted / revoked | 有效 / 已停用 / 已过期 / 额度用完 / 已撤销 | ok / neutral / warn / warn / neutral | 启用 / 编辑 / 撤销 |
| 余额 | ok / warn / bad / zero | — | ok / warn / bad / bad | 充值 / 马上充值 |
| 订单 | pending / paid / failed / timeout / unknown | 等待支付 / 已到账 / 支付失败 / 已超时 / 待确认 | warn / ok / bad / neutral / neutral | 重新支付 / 查询 |
| 订阅 | active / exhausted / expired | 生效中 / 额度已用完 / 已到期 | ok / warn / neutral | 购买 |
| 异步任务 | queued / running / done / failed | 排队中 / 处理中 / 已完成 / 失败 | neutral / accent / ok / bad | 详情 / 查看结果 / 重试 |
| 更新 | idle / checking / latest / available / downloading / downloaded / failed | 见 04 §15 | — | 检查 / 下载 / 重启安装 / 重试 |
| 外接工具 | enabled / disabled / update / authExpired | （开关）/ 可更新 / 授权过期 | — / warn / bad | 更新 / 重新授权 |
| 公告 | promo / warn / info | 优惠 / 维护 / 公告 | accent / warn / info | 可选动作 |

## 5. 错误映射表 `registry/errors.ts`（后端 / 系统错误 → 用户看到的话）

| 来源 | 错误 | 标题 | 说明 | 动作 |
|---|---|---|---|---|
| HTTP | 401 `/api/user/self` | 登录已过期 | 工具里已写入的 Key 还能用，余额和用量不再更新 | 重新登录 |
| HTTP | 401 工具探针 | Key 失效 | 〈工具〉打不开对话，需要换一把 Key | 一键修复 |
| HTTP | 402 / 余额 ≤ 0 | 余额已用完 | 所有请求会被拒绝，充值到账后立即恢复 | 马上充值 |
| HTTP | 429 | 请求太频繁 | 稍等几秒再试 | 重试 |
| HTTP | 5xx | 星芒服务器暂时出错 | 已装好的工具照常能用 | 重试 · 看状态 |
| 网络 | 超时 / DNS | 连不上星芒服务器 | 同上 | 重试 · 检查网络 |
| npm | EPERM / 被占用 | 安装被杀毒软件拦住了 | 05 §3 | 复制路径 · 重试 |
| npm | ETIMEDOUT / ECONNRESET | 下载超时 | 05 §3 | 换官方源重试 |
| npm | EACCES | 需要管理员权限 | 05 §3 | 以管理员身份重试 |
| 更新 | 校验失败 / 签名不符 | 更新 x 没有装上 | 当前版本不受影响 | 重新下载 · 看日志 |
| 支付 | 窗口被关 | 支付窗口已手动关闭 | 订单没有取消 | 看订单 |
| 支付 | 30 min 未到账 | 订单已超时 | — | 重新支付 |
| 备份 | SHA-256 不匹配 | 备份文件校验失败 | 未做任何改动 | 换一份 · 找客服 |
| 平台 | safeStorage 不可用（Linux） | 这台电脑无法安全保存密码 | 只保留本次登录 | 知道了 |
| 平台 | 无托盘（Linux） | 关闭窗口会直接退出 | — | 安装扩展 |

未列出的错误：标题「〈动作〉没有成功」，说明「已自动撤回，不会留下半成品」，动作「重试 · 查看日志 · 找客服」。**永远不把错误码或英文原文直接给用户看**；原文进「反馈」页日志。
