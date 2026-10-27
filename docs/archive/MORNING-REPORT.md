# 过夜自主开发晨报（2026-08-09 夜）

> 执行方式：Fable 5 主协调 + Sonnet 实现 + Opus 审查流水线，/loop 自主轮询。全程本地 commit、**0 push、0 生产网络写操作**。回滚基线 `de56d3d`。

## 一句话结论

**7 条验收标准全部达成**，界面改造 A+B 全部落地为可运行骨架（含新能力 new-api 客户端），无人看管期间零事故、零垃圾账号。8 个提交全部经 Opus 对抗审查（2 处 NEEDS-FIX 已修复后合入）。**有 2 项产品/法务决策需要你拍板**（见下），其余均已按既定授权自主完成。

## 提交链（本地，未 push）

```
f7f366b fix(startup) 引导预览绕过欢迎门 + e2e smoke 夹具跟进（W6 收尾）
c0d9e7d feat(ui)    概览「下一步」任务卡 + 设置页重看引导（W5）
3047491 feat(account) 账号区三态 + 登录/注册对话框 + 充值入口骨架（W4）
a79e1e5 feat(ui)    欢迎页实装 + 启动显示规则（W2）
d8eebc0 feat(account) new-api 客户端骨架 + 6 个账号 IPC 通道（W3）
c7f220b feat(ui)    设计令牌基座 + 导航 IA 任务视角改版（W1）
1455649 docs        infinite-canvas 集成侦察（纯静态审计）
de56d3d docs        欢迎页合成定稿草图（睡前）
```

## 验收标准逐条

| # | 标准 | 状态 |
|---|---|---|
| 1 | 新导航上线，原 11 页全部可达，e2e smoke 不红 | ✅ onboarding-smoke exit 0；electron-smoke 回归相关断言全绿、10 页全遍历（残留 exit 1 为沙箱环境噪音，见文末） |
| 2 | 欢迎页按定稿呈现、单屏、启动规则生效（老用户不被拦） | ✅ Playwright 实测 757px 单屏；shouldShowWelcome 逐形态核实老用户直进工作台 |
| 3 | new-api 客户端 + IPC 通道、mock 测试、零生产写操作 | ✅ 58 测试；I13 脱敏 Opus 独立追踪；零生产网络 grep+实测双证 |
| 4 | 账号区/充值/客服/任务卡骨架可见可点 | ✅ 提交按钮全 stub toast，零生产网络 |
| 5 | 新页面走设计令牌、明暗两态 | ✅ 令牌基座零视觉漂移（153 var() 逐一比对） |
| 6 | 每步 Opus 审查后本地 commit | ✅ 8 波全审查 |
| 7 | typecheck 0 错、全量测试 0 失败、compile 通过 | ✅ 975 vitest + 79 node 全绿，compile exit 0 |

## ⚠️ 需要你拍板的决策（我没有半夜替你定）

**画布相关（来自 docs/RECON-canvas.md 静态审计）：**
1. **法务**：`basketikun/infinite-canvas` 已改 MIT 允许商用闭源，但 `plugins/infinite-canvas/.codex-plugin/plugin.json` 单独写 AGPL-3.0 与根 MIT 冲突——用该 Codex 插件子目录前须人工确认（AGPL 有网络服务开源回馈义务）。
2. **安全（白标前必须）**：画布插件系统从任意 URL 拉 JS 在主源执行、无签名无沙箱、与本地 API Key 同源同权限（作者 SECURITY.md 承认的故意取舍）。付费白标前须定：收紧为插件白名单 vs 保留但把风险警告翻译进中文 UI。
3. **原「剥离返佣码」前提不成立**：画布是纯前端 BYOK，无后端/账号/返佣码，接 xm.solov.cc 是新增对接工作而非剥离。schemaVersion 字段可直接加。作者留了有偿定制联系方式（省事选项）。

**骨架里的占位值（接真实功能前需确认）：**
- 试用额度：欢迎页用「领试用额度」不写死数字（后台额度策略待你定 + 需在 new-api 后台配置）。
- 余额告警阈值 $5、密码最短 8 位：均注释标待产品/后端确认，仅影响客户端 UX。
- 客服：企业微信二维码 + 链接用**占位图 + TODO**，等你补正式素材（一次静态替换 + 外链白名单加一行）。
- 注册方式：当前 xm.solov.cc 仅**邮箱+密码**可用（微信需你申请开放平台应用、GitHub 需配 OAuth、手机号 rc.22 无上游支持）。

## 醒后可接的下一步（技术就绪，等你点头）

- **接真实账号功能**：W3 的 new-api 客户端 + 6 个 IPC 通道已就位，W4 的登录/注册表单提交按钮现在是 stub。把 stub 换成真实调用即可打通"注册→自动生成 Key→查余额→充值"。这一步会产生真实生产网络调用，我按约定留给你醒后决定何时开。
- **画布集成**：等上面两个决策后，再决定是本地跑 dev 验证 / 联系作者定制 / 桌面内嵌。

## 遗留打磨项（低优先，已入任务板 #23-27）

- welcome 独立 AppWindowMode（现复用 dashboard 几何，功能正确）
- refreshAccessToken 接日志前补 cookie 值进 secrets（今零影响）
- 欢迎页 3 个 nit（星图硬编码 provider 数组、9px 裸字号、toast 用 success 应 info）
- Grok 安装回滚不清理 agent 链的窄边界
- CodexOnboarding 无通用退出按钮（本轮已给重看场景加了「返回工作台」逃生口）

## 沙箱环境情报（供你知悉）

这台开发机是**管理员提权 shell + K 盘（非 C:\Users）**，会让 `e2e/electron-smoke.mjs`（非 CI 项，CI 只跑 electron-ci-smoke）在此机无法全绿——安全边界按设计拒绝通过 ACL 可写的 `D:\Node\node.exe` 跑 CLI（I2/I14 正确行为）、`%USERPROFILE%` 路径缩写在非 Users 盘不触发。均非代码问题，换普通权限 + `C:\Users\` 下检出即恢复。修复代理用非提权计划任务实验证明了这一点。

## 数字

- 本次过夜 8 个提交；今日累计约 30+ 本地提交，0 push。
- 全量测试 975 vitest passed / 150 skipped / 0 failed + 79 node passed。
- 中断一次（凌晨 5am 额度上限，W2/W3 半成品已干净回退后重派，无损失）。
