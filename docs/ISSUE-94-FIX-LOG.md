# Issue #94 修复进度

Issue: https://github.com/xufei5620/xingmang-ai-manager/issues/94

本文件记录本地修复进度。按用户要求，本轮不提交 PR、不发布新版本。

## 清单

| 编号 | 问题 | 状态 | 验证 |
| --- | --- | --- | --- |
| H1 | 官方账号切换后重启被静默改回星芒 | 已修复 | 持久化 `officialProviders`；启动准入、托管目标、引导和保存回切均尊重/清除标记；48 项定向测试与类型检查通过 |
| H2 | 服务端作废托管 Key 后缓存不自愈 | 已修复 | `electron/account-cli-provisioner.ts`：bypassCache 验活，凭证失败删除并重签；29 项托管/聊天缓存测试通过 |
| H3 | Gemini API/OAuth 模式回读门失效 | 已修复 | merge 强制写入 `security.auth.selectedType=gemini-api-key`；配置摘要回读并校验 Gemini 模式；97 项相关测试通过 |
| H4 | 首次托管引导失败无手动/登出逃生路径 | 已修复 | Codex 失败才阻断；其他分组和缓存警告降级显示并继续；失败态提供返回工作台、退出登录、授权码配置入口；类型检查通过 |
| H5 | 托管 Key 缓存损坏或 safeStorage 失效无法自愈 | 已修复 | 初始化捕获缓存读取异常并继续签发；`save()` 隔离损坏文件后重建；safeStorage 不可用保留明确警告；相关缓存/托管测试通过 |
| H6 | Node MSI 提权安装存在用户可写暂存 TOCTOU | 已修复 | same-user 也使用受保护安装缓存；UAC broker 临执行前重新校验 SHA-256 与 Authenticode；23 项 Node runtime 测试通过 |
| M7 | PendingFileRenameOperations 误报系统待重启 | 已修复（既有工作区改动） | node/system-service 测试通过 |
| M8 | 主动卸载 Codex Desktop 后每次启动重装 | 已修复 | 持久化卸载偏好；启动/引导跳过自动安装；扫描到手动安装或安装成功后清除偏好；150 项相关测试通过 |
| M9 | 每次重新登录都重放完整 bootstrap | 已修复 | 登录成功先复用持久检查点、环境扫描和配置漂移判定，已就绪直接进入工作台 |
| M10 | 维护页新装 CLI 后未立即配置 Key | 已修复 | 账号站点登录状态下，维护页新装/更新成功后立即为该 Provider 签发并写入托管 Key，失败原因单独提示 |
| M11 | 安全写入 copyFile 回退破坏原子性 | 已修复 | 默认禁止非原子就地覆盖；兼容回退需显式开启并复核文件身份；原文件保持完整 |
| M12 | 启动关键路径重复探测 | 已修复 | 启动快速路径用一次 `system:scan` 同时推导配置、Node/npm、CLI 和桌面端 readiness |
| M13 | 重播引导自动执行且无法中途退出 | 已修复 | 设置页重播进入预览态，用户点击开始后才执行，失败态可返回/退出/改用授权码 |
| M14 | provider merge 模板和回退选择不完整 | 已修复 | Codex merge 补齐 `wire_api`/`requires_openai_auth`，无 active provider 时不再劫持用户首个自建表项；相关配置测试通过 |
| L1 | F7/F8：缓存 revision CAS 与模型缓存 bypass | 已修复 | `electron/managed-cli-key-store.ts` 增加 revision/CAS；配置验活禁用模型缓存；29 项测试通过 |
| L2 | F9：首扫未落地时一键配置误报未安装 | 已修复 | 一键配置入口在首扫进行中等待扫描并重新计算目标，避免误报未安装 |
| L3 | F10/F11：部分失败原因、重试入口和错误文案 | 已修复 | 按 Provider 展示失败原因，托管失败项自动进入“仅重试失败项”对话框，错误文案脱敏并限制长度 |
| L4 | F12/F13/F14：IPC 站点校验、缓存 reveal、配置写入边界 | 已修复 | IPC 拒绝 manual-key 站点托管签发和空目标；作废 Key 禁止复制/明文；写配置前增加账号会话守卫 |

## 记录规则

- 完成一项后立即把状态改为“已修复”，写入改动文件、测试命令和结果。
- 只使用本地工作区；不执行 `git commit`、`git push`、PR 或发布操作。

## 本轮最终验证

- `npm run typecheck`：通过
- `npm run canvas:prepare`：通过（画布产物已刷新）
- `npm run test:windows` 串行回归：2474 passed、160 skipped；4 个符号链接权限失败为既有 Windows 环境基线，未新增失败
- `npm run test:node`：88 个脚本测试 + 18 个浏览器测试全部通过
- `git diff --check`：通过
