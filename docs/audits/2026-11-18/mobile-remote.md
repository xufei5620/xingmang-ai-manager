# 星芒 AI 管理工具 0.2.24 发布前 · 手机遥控专项复核

**2026 年 11 月 18 日，北京时间。** 微信和飞书均在范围内。复核基线是 GitHub 主分支 `ca72c206`。当时公开最新版本和仓库版本号均为 0.2.23，0.2.24 的遥控功能已进入主分支的待发布记录。这里的结论对应这一份源码。 [主分支提交](https://github.com/xufei5620/xingmang-ai-manager/commit/ca72c2062e6b934cad45af18206db083f2bd3730) · [公开版本](https://github.com/xufei5620/xingmang-ai-manager/releases/tag/v0.2.23) · [未发布改动](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/changes/unreleased/codex-remote-fixes-0224.md)

**专项记录 21 项。** M01–M19 均在当前代码的本地隔离环境观察到用户可见的问题。M20 观察到重复提交，手机是否双收仍待平台确认。M21 从源码确认了异常处理缺口，实际退出结果待验。这些编号用于跟踪本轮观察，部分行为也涉及旧功能。下方另有旧工单复核，与专项观察存在重合。

**发版前最先验收三件事。** 第一，手机说停了，电脑上那项任务就应当确实结束。不能确定时，应能查回原任务。第二，任务的文字、图片和工作目录从接单到完成要始终属于同一项。第三，手机没收到最终答案，应能补取答案，不需要把工作再做一次。这三件分别关系到重复执行、做错项目和额外消耗。

## 建议的修复顺序

| 顺序 | 编号 | 交付目标 |
|---|---|---|
| 发版前优先 | M01–M09、M18 | 同一任务只执行预期的次数，使用用户选定的图片和目录，能确认停止并补取结果。暂时读不到配置时保留原设置。 |
| 随后处理 | M10–M17、M19 | 登录、在线状态、消息送达、进度卡和余额提示与实际情况一致。 |
| 优先补证 | M20、M21 | 核实平台端最终投递与异常退出结果，再据实确定影响范围。 |

## 验证范围与方法

检查沿“扫码和配对 → 开启渠道 → 手机发图文 → 电脑启动 Codex → 审批、停止、切目录 → 返回结果 → 关闭、重登和重连”进行。模拟只替换相关的手机平台、Codex 子进程、时钟或存储故障，待查的应用逻辑使用当前源码。分别记录了正常对照、失败时的用户提示、发出的任务数和最终状态。界面用本机 Chromium 加载实际组件。没有连接生产微信、飞书或模型服务，没有向真实联系人发消息或改动真实项目文件。

飞书用 WebSocket 从飞书接收事件，微信采用轮询。管理工具与本机 Codex 之间另走标准输入输出。飞书显示在线只能说明聊天渠道的状态。模型中转有没有使用 WebSocket、某次请求为何 413，要看那一次模型请求的记录。此专项没有产生模型请求或账单。 [飞书连接](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L617) · [本机 Codex 通信](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-process.ts#L29)

## 任务、图片与项目目录

### M01　停止请求失败，电脑回到空闲，渠道仍生成“已停止”通知

在电脑点停止后，模拟 Codex 返回失败。管理工具变成空闲、通知已停止，还允许启动第二项任务。旧任务在真实电脑上是否继续，要看 Codex 当时的状态。 [codex-remote-service.ts 第 1634 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1634) · [codex-remote-service.ts 第 1267 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1267)

**修复与验收**　保留“正在停止／结果待确认”，收到结束通知才显示已停止。停止被拒、超时和稍后才成功三种情况下，都要能找回原任务，并拦住冲突的新任务。

### M02　启动回执晚到，第二条任务可以和第一条重叠

模拟 Codex 已接到第一项任务，60 秒内没有回执。管理工具显示失败并接受第二项，迟到的第一次回执无人处理。离线替身上同时有两项。 [codex-remote-app-server.ts 第 151 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-app-server.ts#L151) · [codex-remote-app-server.ts 第 267 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-app-server.ts#L267)

**修复与验收**　给已提交的任务保留编号和待确认状态。分别测试请求根本没到、执行已开始但回执晚到，确认再试后只有预期的一项。

### M03　任务做完了，手机没收到答案。“重试”会重新做

让渠道仅在发送最终答案时失败。电脑记录为已完成。连接恢复后发“状态”取不回答案，发“重试”产生第二次任务提交。 [codex-remote-service.ts 第 1832 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1832) · [codex-remote-service.ts 第 2663 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2663)

**修复与验收**　分开记录执行结果与送达结果，为原绑定人保留有时限、能清理的结果副本。短暂断网恢复后应能重发答案，任务启动次数仍为一。

### M04　图和文字一起发，缺图仍开始做

让普通图片下载失败，捕获到一次纯文字任务提交。涉及“看图修改”的工作会在关键材料缺失时开始。 [codex-remote-service.ts 第 1904 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1904) · [codex-remote-service.ts 第 2469 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2469)

**修复与验收**　图文作为一项受理。全丢图和只丢部分图片时提示补图，或由用户明确选择按现有材料继续。全取到时照常开始。

### M05　上一条图文被拒绝，图片却进了下一条任务

上一单忙时发图文，手机收到忙碌提示。上一单结束后发完全不同的文字，第二单实际带上了被拒那条消息的图片。 [codex-remote-service.ts 第 1904 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1904) · [codex-remote-service.ts 第 2394 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2394)

**修复与验收**　忙时整条图文一起退回。下一项应只含新消息的材料，另外保留用户主动先发图、下条补说明的用法。

### M06　换了工作文件夹，旧项目的照片和重试内容会跟过去

在 A 收下图片，切 B 再发说明，B 带上了 A 的图。在 A 做完图文任务，切 B 后发“重试”，旧指令与旧图在 B 重新提交。 [codex-remote-service.ts 第 1089 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1089) · [codex-remote-service.ts 第 2394 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2394)

**修复与验收**　把待用图片和重试记录绑定原文件夹。切换后重试需明确显示原目录和目标目录。新目录的纯文字任务不得自动带上旧图。

### M07　电脑换文件夹的同时手机派单，做完后仍卡在“处理中”

让电脑保存新文件夹稍慢，同时从手机发一项普通只读任务。任务在旧目录启动并报告已结束，管理工具仍显示运行中，下一条被拒。 [codex-remote-service.ts 第 1047 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1047) · [codex-remote-service.ts 第 2374 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2374)

**修复与验收**　切目录和接单按先后完成其一。交错情况下，已接任务始终能收到自己的完成通知。验证切换成功、慢保存与保存失败。

### M08　图片没下载完，手机的“停止”排在图片后面

模拟一项正在执行的任务，再发一张慢图及“停止”。图片下载期间没有向 Codex 发出停止，图片取完才发。两种渠道共用此接收流程。 [codex-remote-service.ts 第 1853 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1853) · [codex-remote-service.ts 第 1934 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1934)

**修复与验收**　给已绑定用户的停止指令单独的处理通路。让一张图片保持下载中，确认停止已经到达 Codex，再验证迟到图片不影响下一单。

## 设置、登录与消息送达

### M09　遥控设置第一次读取失败，改一个开关可能覆盖其他设置

在临时目录中模拟首次读盘时文件正忙。旧设置仍在磁盘，程序却记住了空设置。随后保存一个偏好，重新打开后原工作目录和 12 小时闲置设置都丢了。 [codex-remote-store.ts 第 150 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-store.ts#L150) · [codex-remote-service.ts 第 1187 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1187)

**修复与验收**　区分初次使用和暂时读不到。读失败后允许重读，未取得现存配置前停止覆盖。恢复后再改一个偏好，要保留原目录及其余字段。

### M10　微信从没成功收到过回应，也会显示绿色“已连上”

只让收消息请求在本机超时，成功回包为零，界面状态仍可从连接中或出错变成已连接。微信正常返回空消息的对照也显示已连接。 [codex-remote-weixin-api.ts 第 506 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-api.ts#L506) · [codex-remote-service.ts 第 1519 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1519)

**修复与验收**　只有收到了有效响应才首次显示已连接或清除故障。验证一直超时、出错后超时、真正恢复三种情况。

### M11　微信输完验证码遇到断网，提示会重试，实际停住了

当前界面收到“2 秒后重试”，等待超过 2 秒，后续请求数为零。对照普通扫码等待会继续查询，额外查询一次也确实可推进验证码流程。 [codex-remote-weixin-login.ts 第 245 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-login.ts#L245) · [WeixinRemoteSection.tsx 第 126 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/WeixinRemoteSection.tsx#L126)

**修复与验收**　区分正在等用户输入与已经提交、正在等恢复。网络恢复后自动继续，或给出清楚的手动重试操作。取消、填错和过期各有明确结果。

### M12　微信扫码已进入保存阶段，点取消后仍可能登录成功

二维码确认前取消，凭据写入为零。进入保存阶段后取消，登录信息仍写入一次。在这次对照中，遥控开关保持关闭。 [codex-remote-weixin-login.ts 第 149 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-login.ts#L149) · [codex-remote-service.ts 第 1329 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1329)

**修复与验收**　保存提交前的取消应终止该次登录。若已进入不可取消阶段，显示正在完成登录。慢保存时重新扫码，最终状态只由当前操作决定。

### M13　飞书传输中途断开，会报图片太大，回复也可能放弃重试

用只有 2 字节的响应模拟传输中断，大小限制为 1024 字节。图片报太大，文字发送只试一次。连接在响应头之前失败时会正常重试。 [codex-remote-http.ts 第 154 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-http.ts#L154) · [codex-remote-feishu.ts 第 533 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L533)

**修复与验收**　分别识别断网、取消、超时和真正超限。对可重试的操作保持同一消息编号。覆盖传输前、中途两种断网和真正超限。

### M14　电脑已关闭飞书遥控，排过队的普通消息还会发出

等电脑明确返回已关闭后恢复模拟网络，旧的开启提示和帮助回复仍发出，另有一条符合设计的告别。未观察到因此执行新任务。 [codex-remote-feishu.ts 第 690 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L690) · [codex-remote-feishu.ts 第 887 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L887)

**修复与验收**　关闭时取消旧的普通发送与重试，保留单独的告别流程。检查排队、等待重试和重新开启三种时序。

### M15　桌面收到的遥控状态，新编号可能装着旧设置

延迟第一次读取，再打开自动启动。磁盘保存为开。较早那次读取最后完成，拿到更大的版本号，客户端按规则接纳它后显示为关。 [codex-remote-service.ts 第 966 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L966) · [remote-view.ts 第 11 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/remote-view.ts#L11)

**修复与验收**　在取得一致的设置与运行状态时确定版本。让两次读取反序完成，后收到的旧值也无法把已保存的开关显示回去。

### M16　同一个窗口里，状态栏显示已开，设置开关却显示已关

让已开启的新状态先到、首次读取的旧状态后到。实际设置组件显示为关，同时同页状态栏仍为开。这里传入的两个版本编号本身正确。 [CodexRemoteCard.tsx 第 518 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/CodexRemoteCard.tsx#L518) · [remote-view.ts 第 11 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/remote-view.ts#L11)

**修复与验收**　让设置卡的首次读取也用与事件相同的版本比较。开到关、关到开的反序返回都应在同一窗口得出相同结果。

## 进度卡、目录编号与余额

### M17　飞书最后一次更新卡片失败，任务结束后仍显示正在处理

普通任务已结束，模拟最终更新遇到一次网络故障。电脑回到空闲，推进模拟时间 20 分钟，卡片仍停在“正在处理”。相同故障发生在任务中途时，后一次刷新能恢复。 [codex-remote-service.ts 第 2342 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2342) · [codex-remote-feishu.ts 第 786 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L786)

**修复与验收**　为最终状态安排有限次数的补发，或在连接恢复时同步原卡片。最后一次更新失败、网络恢复后，原卡片应变成已完成或已停止。

### M18　手机刚看过的文件夹编号，会被电脑上的改动重新分配

手机看到 2 号是项目 B，电脑随后移除 B。手机回复“文件夹 2”，实际切到 C，回信也写着 C。用户若直接照旧列表操作，目录已经偏离原意。 [codex-remote-service.ts 第 1058 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1058) · [codex-remote-service.ts 第 2191 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2191)

**修复与验收**　把选择绑定到用户最近看到的列表和目录标识。所选目录已删除或列表已变时应请用户重选，不能用同一个数字默选其他项目。

### M19　查余额遇到网络故障，手机把一小时前的金额当成当前余额展示

余额查询刷新失败，原记录仍保留一小时前的读取时间。微信和飞书都只报一个金额，没有标明沿用了旧数据。这里取的是管理工具登录账号的余额。 [canvas-account-summary.ts 第 109 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/canvas-account-summary.ts#L109) · [codex-remote-text.ts 第 251 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-text.ts#L251)

**修复与验收**　把账户归属和读取时间一并传给手机状态。刷新失败时显示“上次查询”与时间，或省略余额。换号、退出后也要清掉旧金额。

## 实际影响仍需补证的两项

### M20　微信丢失发送回执时，会用新编号再提交同一段回复

离线接收方先接受普通文字，再模拟回执丢失。客户端提交两次且编号不同。正常回包只提交一次。微信服务器是否去重、手机最终显示几条，仍需平台侧证据。 [codex-remote-weixin.ts 第 102 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin.ts#L102) · [codex-remote-weixin-api.ts 第 538 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-api.ts#L538)

**修复与验收**　先核实平台对消息编号的去重承诺，同一发送复用一个稳定编号。对已发出但结果未知的情况单独处理，并验收实际手机最终收到几条。

### M21　退出遥控账号出错时，最终连接状态有待确认

静态复核发现退出流程对本地故障的处理仍有缺口。真实连接是否残留，以及手机端最终看到的状态，均待验证。

**修复与验收**　退出遇到本地故障时，保证遥控进入可确认的停止状态。保留故障提示并支持重试，再次打开管理工具时，电脑和手机的状态应一致。

## 上次的问题修了哪些

此前 [GitHub #1407](https://github.com/xufei5620/xingmang-ai-manager/issues/1407) 的 11 组问题仍挂在同一张工单上。逐组核对当前实现，**6 组已修复，4 组部分修复，1 组条件性仍在**。部分修复已经包含在公开版 0.2.23 中。下表结论以源码为主，没有据此宣称所有手机、企业网络和旧版 CLI 均通过。

| 原编号 | 过去的问题 | 当前状态 | 依据及尚待验收的范围 |
|---|---|---|---|
| P2-1 | 窗口收起后，用户不知道遥控还开着，也不能从托盘关闭 | 已修复 | 托盘能查看并关闭遥控，设置页也说明收起后仍会运行。 [application-tray.ts 第 253 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/application-tray.ts#L253) |
| P2-2 | 审批回复与所授权的请求是否一一对应 | 部分修复 | 卡片已改进，仍需验证所有支持的审批方式均对应用户看到的那一项。 |
| P2-3 | 手机展示与实际批准的权限范围 | 已修复 | 当前实现按用户能完整看到的范围处理，未识别的权限会被拒绝。 |
| P2-4 | 文件读取范围与界面说明 | 已修复 | 当前实现收紧了外部工具范围，并向用户说明绑定的聊天能收到所请求的文件内容。 |
| P2-5 | Windows 运行身份确认 | 已修复 | 身份不明确时会阻止开启遥控。 |
| P3-1 | 关闭遥控后正在启动的任务是否停止 | 已修复 | 对应全项目台账 N1，迟到的启动结果已有收尾。 |
| P3-2 | 审批卡信息和原任务的归属 | 部分修复 | 审批内容和任务归属已有改进，旧版 Codex 的兼容行为仍需验收。 |
| P3-3 | 遥控启动与 Codex 安装、更新、卸载互相干扰 | 已修复 | 启动和安装共用队列。Windows 更新前检查忙闲并释放占用。 [codex-remote.ts 第 71 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/bootstrap/codex-remote.ts#L71) |
| P3-4 | 飞书长连接与普通网络请求的代理、证书处理方式不同 | 条件性仍在 | 飞书长连接与普通网络请求使用不同网络通路，企业代理和自定义证书仍待实网验收。 [codex-remote-feishu.ts 第 616 行](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L616) |
| P3-5 | 旧消息与电脑时间不准 | 部分修复 | 已有提示。跨重启及时间不完整的消息仍需统一处理。 |
| P3-6 | 配对、退出登录、停用和诊断 | 部分修复 | 退出和诊断已改进。配对状态、平台登录状态与本机退出的一致性仍待验证。参见 M21。 |

跨上次全项目台账再核三项。**N1 已修复**，对应上表 P3-1。**N8 已修复**，中文被分成两段传入时保留完整字符，当前两条离线回归通过。**R29-06 部分修复**，已补开启时的状态检查，启停交错情况下仍须验收关闭结果。没有观察到停用后执行新任务。 [N8 实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-app-server.ts#L108) · [全项目复核报告](./project-recheck.md)

## 哪些流程已有正向证据

- 本轮本机 Chromium 运行了 **13 项遥控界面回归，13 项通过**，包括微信扫码、飞书配置、文件夹、最近任务、开机自启、闲置关闭、余额提示和检索入口。另有一组按名称选取的遥控单测，23 项运行、23 项通过，同次发现的其他 398 项未选中。各专项回归之间可能重叠，未把它们相加当作独立用例。 [界面回归](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/e2e/v2-business.test.mjs#L3801)
- 用确定性时钟检查过 4 小时和 12 小时空闲关闭、关前 10 分钟提醒、收到回复后重新计时、默认不自动关闭。有持续进展的任务运行 4 小时仍保留。审批第 7 分钟提醒、第 10 分钟自动拒绝，提前回答会取消提醒。 [计时和状态](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts)
- 微信完成扫码前正常取消没有写凭据。有效空响应能建立已连状态。飞书正常发送有回执。单独关闭飞书后，微信仍可响应“状态”。管理工具退出账号时，余额缓存的对照已清空。
- 原项目的 11 月 17 日验证记录还显示，Codex 0.167.0 和 0.169.0 在隔离环境中都能从初始化走到任务完成。本轮的晚回执、停止失败测试采用模拟子进程。 [原项目验证记录](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/docs/CLI-VERIFIED-VERSIONS.md#L892)

## 发布说明与实现核对

以下 24 组发布承诺均找到了对应代码。它们说明功能已经接入。正常时能使用与异常时能恢复分别验收。

| 功能 | 功能 | 功能 |
|---|---|---|
| [飞书保存后继续显示配对下一步](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/FeishuRemoteSection.tsx#L131) | [配对一分钟无回应时给诊断提示](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L835) | [Codex 启动失败在电脑卡片显示并可回首页](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2437) |
| [配对过的渠道可从托盘重新打开](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/application-tray.ts#L257) | [启动星芒时自动开遥控，默认关闭](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-store.ts#L77) | [空闲关闭可选四小时、十二小时或不自动关](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1199) |
| [遥控打开后给手机一条通知](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1514) | [手机可以关闭遥控](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1881) | [审批快到期前提醒，处理后的飞书卡片更新状态](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2770) |
| [微信扫码补数字验证，验证后绑定扫码者](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-login.ts#L133) | [微信确认已绑定时尝试恢复过期连接](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-login.ts#L160) | [状态回复包含耗时、当前步骤和余额](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2221) |
| [重试上一条任务](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1925) | [完成回复给出耗时和改动文件](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L2639) | [长任务进度卡与微信定时提示](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L155) |
| [保存多个文件夹，手机可查看和切换](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1030) | [飞书和微信图片附到下一次任务](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1881) | [电脑显示最近任务、停止和拒绝全部审批](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-service.ts#L1020) |
| [低余额提示、未配置渠道默认收起、首页入口](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/CodexRemoteCard.tsx#L130) | [飞书聊天二维码、开放平台与教程按钮](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/codex-remote/FeishuRemoteSection.tsx#L41) | [中文跨消息分块不乱码](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-app-server.ts#L110) |
| [飞书临时发送失败自动重试并保持消息标识](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L818) | [飞书连接错误改成可理解提示与动作](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-feishu.ts#L79) | [全角验证码、Mac 菜单栏措辞和解绑确认](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-weixin-login.ts#L73) |

**上线前的真机验收。** 用可控的测试账号，在微信、飞书各走一次发图、切目录、停止、网络中断后恢复和补取答案。电脑上核对原任务与最终目录，手机上核对实际收到几条，测试账户核对任务次数与用量。企业代理、电脑真实休眠唤醒、macOS 退出后的子进程回收，以及其他 Codex 版本的兼容性均需另验。本轮观察不能确认客户已经重复扣费。
