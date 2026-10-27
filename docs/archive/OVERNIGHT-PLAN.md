# 过夜自主推进计划（2026-08-09 夜）

> 用户已批准（含验收标准）。用户补充意见未传达成功，若夜间到达则折入计划。执行者：主会话协调 + Sonnet 实现 + Opus 审查流水线。全程本地 commit、0 push、0 生产写操作。

## 波次

- W1 设计令牌基座（ui-ux-pro-max / frontend-design skill 指导）+ 导航 IA 实装（已批准方案 A）
- W2 欢迎页实装（docs/mockups/welcome-draft.html 1:1 落地 + 启动显示规则 + 客服占位）
- W3 new-api 客户端骨架（docs/RECON-new-api.md 为准；IPC 新通道单一串行任务，T1）
- W4 账号区三态 + 注册/登录表单骨架 + 充值入口骨架（桩数据）
- W5 概览「下一步」任务卡 + 设置页「重看引导」
- W5.5 无限画布骨架（用户睡前补充）：本地克隆 basketikun/infinite-canvas 到 K:\星芒\xingmang-canvas，审计并剥离上游返佣码/邀请码（列清单），跑通本地 dev，写运行说明；不 fork 不 push，桌面侧本夜仅导航占位
- W6 全量门槛 + e2e smoke + 晨报（docs/MORNING-REPORT.md）

## 验收标准

1. 新导航上线，原 11 页全部可达，e2e smoke 不红
2. 欢迎页按定稿呈现、单屏铁律、启动规则生效（已配置用户直进工作台）
3. new-api 客户端 + IPC 通道就位、mock 单测覆盖、零生产写操作
4. 账号区/充值/客服/任务卡骨架可见可点，边界给「待开放/待素材」反馈
5. 新页面全走设计令牌，明暗两态齐全
6. 每步 Opus 审查后本地 commit；可整体回滚到 de56d3d
7. 终态 typecheck 三连 0 错、全量测试 0 失败、compile 通过

## 预拍的保守决策（晨报待改判清单起点）

- 注册/登录表单骨架期禁用真实提交（按钮标「即将开放」），不产生任何生产账号
- 欢迎页主题跟随应用当前主题（设计代理建议的「默认浅色」留待用户改判）
- 画布占位点击 → toast「即将上线」
- 充值入口 → 外链打开 xm.solov.cc 对应页面（白名单精确加 URL，路径以 new-api 前端真实路由核实为准）
- 遇产品分叉一律选保守可逆项并记晨报
- **W5.5 安全收紧（凌晨决策）**：原计划「跑通本地 dev」改为**纯静态审计**——canvas 仓库带 URL 动态加载远程插件、未过审，npm install 的 postinstall 即无监督下的任意代码执行，风险过高。画布代理只读审计写 docs/RECON-canvas.md，不执行任何代码、不改 canvas 仓库、不 fork/push（已把 origin push URL 禁用为占位符）。跑 dev 与集成改动留给用户醒后监督执行。已完成并提交。

### W5.5 画布审计结论 → 晨报待用户决策（不半夜替用户定）
1. **原「剥离返佣码」前提不成立**：canvas 是纯前端 BYOK，无后端/账号/支付/返佣码。接 xm.solov.cc 账号体系是**新增对接工作**，非剥离。
2. **License 好消息**：v0.15.1（当前 HEAD）已主动改 MIT，CHANGELOG 明写允许商用闭源。
3. **待决策A（法务）**：plugins/infinite-canvas/.codex-plugin/plugin.json 写 AGPL-3.0，与根 MIT 冲突。疑似 MIT 化时漏改的子文件，但用该 Codex 插件子目录前须人工确认（AGPL 有网络服务开源回馈义务）。
4. **待决策B（安全，白标前必须）**：插件系统从任意 URL 拉 JS 在页面主源执行、无签名无沙箱、与本地 API Key 同源同权限（作者 SECURITY.md 承认的故意取舍）。付费白标前须定：收紧为插件白名单 vs 保留但把风险警告翻译进中文 UI。
5. schemaVersion：canvas-agent/src/canvas/types.ts 目前无该字段，可直接加。
6. 作者 README 留了有偿定制联系方式——可作为「联系作者定制」的省事选项供用户参考。

---

## 恢复状态（凌晨额度上限中断后）

**已完成并提交**：W1 令牌+导航（c7f220b）、W5.5 画布静态审计（1455649，结论见上「待用户决策」）。工作区已回退干净，HEAD=c7f220b。

**中断**：W2、W3 同时撞会话额度上限（5am 重置），均被杀。W3 零改动；W2 半成品已回退。等重置后**全新重派**（非 resume）。

**W2 重派要点**（只碰 src/App.tsx、app-shared.ts(.test)、styles.css、components/welcome/；禁碰 electron/、types.ts）：按 docs/mockups/welcome-draft.html 定稿建 WelcomePage.tsx，复用 W1 令牌禁硬编码；AppView 加 'welcome'；启动规则=未配置星芒 Key 进 welcome、已配置直进既有流程（老用户不拦）；注册 CTA 骨架 toast、我有授权码→既有 onboarding；单屏无滚动；可测判定抽 app-shared 纯函数（T7 不加 jsdom）。基线 863/150/0。

**W3 重派要点**（只碰 electron/new-api-client.ts(.test)、ipc-contract.ts、ipc.ts、preload.ts；禁碰 src/App.tsx、app-shared、styles.css、components/）：按 docs/RECON-new-api.md 建客户端骨架（status/login 双轨/self 余额换算/CLI Key 三连调），每请求 I10 四要素+双头，I13 脱敏+I3 不留明文；加账号 IPC 通道注意 T1 键顺序=注册顺序、ipc.test.ts:227 顺序断言；mock 单测禁触生产实例。基线 863/150/0。

**后续**：W4 账号区/注册登录/充值骨架（需 W2+W3）→ W5 任务卡+重看引导（碰 App.tsx，W2 后串行）→ W6 全量门槛+e2e+晨报 docs/MORNING-REPORT.md。每波 Opus 审查后本地 commit。
