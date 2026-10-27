> 统一审查报告的专项附件；固定源码基线为 c21be274，后续新增提交见 [最新增量复核](../latest-delta.md)。本页中的本地证据名称用于维护者对账，关键观察结果已在正文给出；完整受控材料不公开。

# 冻结 legacy 回滚界面：本轮复核与安全修复方案

本轮基线为 `c21be2741af6674b2f422d9891b57fc3d2ba5b7b`，目录 ``。仅检查分配清单、离线运行原模块和组件；未修改产品代码、真实配置，未请求生产、安装工具或发送真实 AI 请求。以下“仍存在”只针对该基线。

**结论：确认旧项 S03 仍存在；本范围没有确认第二项新的安全问题。** S03 可以按 legacy 冻结规则的安全修复例外处理。普通功能缺陷、旧界面与 v2 的功能差异仍按 T14“legacy 已冻结，不修”，不借本报告提出功能改版或删除旧回滚入口。

## 覆盖与证据层级

分配的 `legacy-inventory.json`（本地受控证据）共 41,207 行，逐个重新计算 SHA-256，187/187 与清单一致；收尾又对同一 187 文件复算，未发生摘要变化。每个 path 的 hash、review_level、具体说明见 `legacy-coverage.json`（本地受控证据）。

| 层级 | 文件 / 行 | 实际做了什么 |
|---|---:|---|
| `reuse_full` | 122 / 34,745 | 当前文件与 ffc04922 旧源码逐个 SHA-256 一致，且旧 `legacy_security-coverage.json`（本地受控证据）记录完整行区间与 full；复用旧全文语义审阅，本轮另做全文件安全模式扫描并重读核心敏感路径。**不是本轮重新逐字读了这 122 文件。** |
| `fresh_full` | 10 / 1,038 | 本轮全文读了原覆盖未包含的账号配置/来源纯逻辑、账号展示辅助、请求协调器、一个 CSS、组件能力文档及 legacy package.json。 |
| `fresh_support_test_review` | 55 / 5,424 | 逐文件核对 imports、用例契约及安全相关断言，安全重点另读原测试源；实际运行全部 55 个测试文件。**没有宣称全部测试夹具逐行人工重读。** |

`legacy-hash-comparison.json`（本地受控证据）、`legacy-current-security-scan.json`（本地受控证据）、`legacy-test-contracts.json`（本地受控证据）、`legacy-review-summary.json`（本地受控证据）均已落盘。覆盖记录中的 completed 表示对应层级的工作完成，不表示没有漏洞，也不把测试契约审阅升级为全文语义阅读。

## S03

此安全条目已纳入 [公开状态与验收目标](../security-status.md)。详细触发条件、定位与受控复现保留本地，按仓库安全策略不随公开 PR 发布。

## 本轮确认仍有效的保护及没有新增结论的范围

| 安全边界 | 本轮证据与限制 |
|---|---|
| Markdown / 导航 | 聊天 Markdown 的链接、图片替换为文本；法律条款 `skipHtml`、链接和图片惰性展示，回退外链用固定常量；公告点击交主进程 openExternal。法律文档 7 个相关测试通过。本范围没有确认新 HTML 执行或任意跳转漏洞；主进程完整外链校验由其独立审查负责。 |
| 凭据展示 | 账号 Key 默认掩码，专用 reveal 才取明文，key tab 离开、卸载与迟到响应有失效处理；8 个 AccountCenterPage 测试通过。手动配置 Key 属于既有专用显示边界，不把用户主动 reveal 本身报为漏洞。 |
| CLI Key 自动配置 | 新读 `account-provisioning.ts`：只传 provider/model 元数据；自动写不伪造 explicit，用户确认写逐个 provider 发送。29 个相关测试通过。并不由此替代主进程 Key 签发、额度/归属或文件事务审查。 |
| 保存账号来源与偏好 | 账号切换同源及 URL 凭据拒绝测试通过；onboarding-choice 的站点/用户复合键已有独立 2 用例。S03 的独立边界结论见安全摘要。 |
| 扩展/异步 | 新读 provider-extension-coordinator，核 provider、request sequence、响应 provider 和卸载失效；3 用例通过。未把旧 #9 在其他树的状态混入本项。 |
| 样式、基础 UI、旧工具链 | 原全文证据 hash 一致；本轮源码模式扫描未命中 raw HTML/script 动态执行、renderer 直接 fetch/WS、shell:true 或 CSS 外站 URL/import。固定 React 18 依赖及无安装脚本已核；未联网做 CVE 数据库审查。模式扫描不是独立“无漏洞证明”。 |
| 普通功能 | 历史组件能力登记里部分 dirty 确认、单 Toast、文件拖放等未统一项是旧文档观察；旧 provider/Gemini 展示和一般异步体验同属冻结功能范畴。本轮未以未经复现的一般缺功能新增问题编号；依 T14 保留“legacy 已冻结，不修”，不提功能修复方案。 |

## 验证记录与局限

运行清单全部 55 个支持测试，**453 通过、0 失败、0 跳过**。见 `legacy-vitest-run.log`（本地受控证据） 和 `legacy-vitest-results.json`（本地受控证据）。临时配置复用仓库的 React 18 精确别名和相同 React 插件，并把缓存与报告放到临时目录，未修改仓库测试。

```powershell
# 工作目录为本轮 worktree
node node_modules/vitest/vitest.mjs run --config 本地证据/legacy-vitest.config.mjs
```

最初临时 harness 曾因 Windows ESM 路径及字符串别名匹配子路径而启动失败/缺模块；修正的是仓库外配置，产品源码未动。最终 55 文件、453 用例的结果才是有效回归结果；保留 `legacy-vitest-harness-alias-error.log`（本地受控证据）便于区分测试搭建失败与产品失败。

聊天原有 2 文件 24 用例同样全部通过，但既有测试没有覆盖 S03 的独立安全场景，因此不能否定受控复现。未重跑全仓 npm test/typecheck，未做打包后 Windows/macOS/Linux 真机验收、全主题视觉回归、生产账号或付费 API 验证。除 187 文件外，仅定向查看会话域字段契约以确定安全修复方案，并未把主进程全链宣称为本专项已审完。
