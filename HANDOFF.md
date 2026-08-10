# 滚动报告(无人值守自主轮询)

> 本文件 = 云端 agent 的滚动交接报告,**每完成一波就更新并随代码推送**。
> 接手协议:任何新会话 `git checkout local/integration` + 读本文件顶部三栏即可无损继续。
> 与 CLAUDE.md 或代码冲突时,以代码为准。上一版 HANDOFF(2026-08-10 静态交接稿)已由本报告取代。

---

## ① 等老板拍板(全部跳过不猜,按下列编号答复即可)

1. ~~站点下拉命名~~ **已拍板并落地(2026-08-10)**:统一「星芒AI」,下拉两项为「星芒AI（账号登录）」(new-api / xm.solov.cc)与「星芒AI（Key 直连）」(sub2api / api.solov.cc)。
2. **勘合遗留**:xm.solov.cc 签发的 key 在 api.solov.cc relay 上是否真能推理成功——生产验证类,agent 不碰生产,等你真机验。
3. **客服素材**:欢迎页企业微信二维码仍是占位图(`WelcomePage.tsx` 有 TODO),等正式素材(一次静态替换 + 白名单一行)。
4. **试用额度**数字 + new-api 后台配置;余额告警阈值 $5 是否认可。
5. **注册方式扩展**:微信需开放平台应用、GitHub 需配 OAuth——要你去申请,代码侧不阻塞。
6. **A 真机验证清单**(只能你走):账号后半程(重启保持登录/token 续期/收重置邮件/个人中心真实数据);Key 管理表 7 列一屏不溢出;正常环境点开画布看观感;改密码「原密码错误」文案实测。
7. **死分支处置建议(仓库整理波已盘点,只列不删——删不删由你定)**,基于 xufei5620 fork 可见分支(peaker520 上游侧本会话无权限枚举):
   - `feat/macos-support`(87cb20c)与 `xufei5620/claude-cloud/runbook-cleanup`(8102f0b):**已全部合入 main** → 纯死分支,可删;
   - `claude/project-review-ma2wvr`(15f898f):已被 `local/integration` 吸收(尚未进 main)→ 集成线合并回 main 后即死,可删;
   - `claude/mac-platform-so8dlw`(321f74b):**不是死分支**——携带未合入实改(macOS 渲染根 URL 策略测试 77 行 + `security.ts` 非 Windows 根 pin `path.posix` + CI 脏树守卫 19 行),建议收编(已列入巡检波候选),勿删;
   - 活跃分支:`main`(默认)、`local/integration`(集成线)、`claude/xingmang-site-naming-batches-xwms7a`(本会话工作分支)。

## ② 从这里继续(断点)

- **⚠️ 当前工作分支**:本会话(2026-08-10 起)因云端会话的分支约束,工作在 `claude/xingmang-site-naming-batches-xwms7a`(基于 `local/integration` 的 `5a8479d`,main 为其祖先)。`local/integration` 本身未动;老板确认后可快进合并该分支回 `local/integration`。
- **双后端 W1→W3 已全链闭合并通过 Opus 对抗审查**。审查七面向里主路径全部攻击失败(粘贴 Key 全链 I13/I3、写入链 I9、契约 T1 零变化、solov 回归面均给了证据),揪出的发现已全部处置:F1(manual-key 降级不完整,3 个 new-api 入口仍可达)→ `5e1f953`;F2-F5(键控制字符校验/解析错误脱敏/诊断读侧站点化/切站刷新快照)→ `ce38200`;F6(字面量 nit)按不镀金跳过。
- **W3 审查遗留的一个功能缺口(非安全,待后续波次)**:manual-key 用户即便已把 Key 写进 CLI,**画布仍拿不到 token**——`canvas-auth.ts` 的 `isAccountAuthenticated()` 为假时 `revealConfiguredRelayKey()` 不执行。画布对 manual-key 站点的适配需要单独一波(让画布也能用已写入的 relay key),不阻塞批次3。
- **⚠️ 本会话输出可靠性告警**:后期出现 inline 命令 echo 被污染(git rev-parse 返回过互相矛盾的 SHA、臆造的提交消息)。**真实状态一律以 `git log`/文件回读为准,不信任 inline echo**。验证方法:命令结果重定向到 scratchpad 文件、用 Read 工具回读。若新会话接手,`git log --oneline` 与 `git rev-parse origin/local/integration` 是可信锚点。
- **之后顺序(老板 2026-08-10 定,全部做完)**:~~批次3~~(**已核实全部落地,无需再改**:3.1=`8c6a476`、3.2/#16=`fd2633c`、3.3/#17=`2c53e6d` + 审计脚本至迟随 `17fef1a` 已 fail-closed;IMPROVEMENT-PLAN 3.1-3.3 已加状态标注——②栏此前"批次3 待做"与背景速查"批次3 未动"均为过期信息)→ **仓库整理**(状态性文档校准/杂物归位/.gitignore 查漏/死分支只列不删)→ **巡检(持续发现-修复)**(每个候选先对抗验证;连续两轮无可行动项即收束)→ **画布 manual-key 适配**(见上一条缺口描述)→ **批次1/2**(逐项先核实是否已被集成线覆盖,再动手)。
- **W3 关键事实(已侦察定案)**:sub2api = Wei-Shaw/sub2api(Go+Vue3);用户侧 Key 页路由 **`/keys`**(frontend/src/router,requiresAuth 非管理员)→ 精确 href `https://api.solov.cc/keys` **已在白名单**(main.ts:73),零白名单改动。sub2api 站点:providerBaseUrls 复用 catalog 形状(含 grok `/v1`)、accountBackend='manual-key'、无账号登录,粘贴 Key 优先复用既有配置写入链(I9),**尽量零新增 IPC 通道**(T1)。
- **轮询协议**:长心跳(约 30 分钟);429/额度类错误不退出循环,退避并加长间隔;接近会话硬上限 → 立即把已完成的推上去、更新本报告顶部再收尾。模型分工:Fable 只规划/拍板/综合审,实现派 Sonnet,安全审查派 Opus。
- **红线(老板原话不可越)**:不推/不合 main、不强推、不删分支、不开 PR、不发 release、不动生产站点、不违反 CLAUDE.md 第 8 节、测试绝不触生产 xm/api.solov.cc;素材/定价/命名/删除类/真机验证类一律进上面第①栏。

## ③ 本轮完成(倒序,含提交号与门槛数字)

| 提交 | 内容 | 门槛 |
|---|---|---|
| `a55058b` | **站点命名定稿(①栏第1项拍板落地)**:统一「星芒AI」,下拉两项「星芒AI（账号登录）」/「星芒AI（Key 直连）」 | tc 0 错;vitest 1328/0 失败 |
| `ce38200` | **W3 审查硬化 F2-F5**:键控制字符校验(拒 NUL 防明文入日志)、配置解析错误脱敏(I13)、诊断读侧站点化(W3a 漏接点)、切站后刷新 config 快照。F6 nit 跳过 | tc 0 错;vitest 1328/0 失败 |
| `5e1f953` | **W3 审查 F1**:补全 manual-key 站点账号入口降级(handleConfigureCliKey/欢迎页/NextStepsCard 三入口),堵住跨站点凭据混线 | tc 0 错;vitest 1328/0 失败 |
| `7cf281b` | **W3b 收官**:设置页站点下拉、账号区 manual-key 降级(不主动登出)、PasteKeyDialog + 纯校验、写入链拆 writeCliKeyForInstalledClis 复用两路径、canvas-window origin 收口(F4 3/3)、**零新增 IPC 通道**。+24 测试 | tc 0 错;vitest 1327/0 失败(基线+24);compile 过 |
| `731db23` | **W3a 半波检查点**(额度中断收尾):sub2api 站点条目(同域双站/label 占位待确认/白名单去重零新增)+ siteBaseUrls 转必填 + 读侧站点化(含唯一授权断言更新)+ origin 收口 2/3 处 | tc 0 错;vitest 1303/0 失败(基线+2) |
| `3872f36` | **W2 审查修复**:F1 `settings:save` 的 parseSettings 补 relaySiteId 直通(降级不抛错,I5 白名单校验)+ 2 条打在真实 IPC 处理器上的回归测试;F2 模型缓存键加站点前缀、站点解析提到缓存查找前;F5 relaySites 收紧为非空只读元组;F6 消真值吞空串与重复求值。F3/F4 记入 W3 必做 | tc 0 错;vitest 1301/0 失败(基线+2) |
| `55696f3` | **双后端 W2**:relay-sites.ts 站点注册表(零依赖,solov 单条目)+ AppSettings.relaySiteId(坏值降级默认)+ 8 处硬编码消费点切站点解析(配置写入/模型列表/诊断探测/白名单派生/渲染层三链接)+ 契约值 re-export(providerIds 先例)。e2e 零改动=默认行为不变的验收 | tc 0 错;vitest 1299/0 失败(基线+16);compile 过(I6 无 node 依赖入渲染包) |
| `9a2a261` | HANDOFF 重写为滚动报告;修正 CANVAS-INTEGRATION-PLAN 过期条目;sub2api /keys 路由侦察定案 | 文档波,typecheck 0 错复核 |
| `a5cb90e` | **双后端 W1**:RelayBackendClient 接口(17 方法各注消费点)+ 能力声明;new-api 挪到接口后,零行为变化;契约/preload 零 diff | tc 0 错;vitest 1283/0 失败(基线+5) |
| `7793d9a` | CLAUDE.md 全面校准到集成后实态(86 通道/新模块地图/I15/T12/T13),行号逐个复核 | tc 0 错;vitest 1278/0 失败 |
| `15f898f` | `npm run dev` 竞态修复:predev 先全量编译主进程(scripts/prebuild-electron-dev.mjs);类型错不阻断 dev 实测过 | tc 0 错;vitest 1278/0;scripts 77/77 |

**基线备忘**(Linux 云端):typecheck 三段 0 错;vitest 0 失败(skipped 为平台门控);scripts node --test 0 失败;e2e 2 个 Playwright 用例需真浏览器,容器版本不符时属环境问题(指 executablePath 复跑即绿,已验证)。

---

## 背景速查(接手补课用)

- **双后端方向(老板已定死)**:new-api + sub2api 一等公民;RelayBackendClient 统一接口;站点数据模型 `{id,label,providerBaseUrls,accountBackend,accountBaseUrl?}`;两站点可共享同一 relay 域(api.solov.cc),只差账号模式;UI 显式站点下拉,不做按 key 自动识别;sub2api 先做"粘贴 Key"最简实现,完整 parity 以后加实现不重构。
- **必读顺序**:CLAUDE.md(不变量 I1-I15/陷阱 T1-T13,保命)→ docs/RECON-new-api.md(改账号前)→ docs/CANVAS-INTEGRATION-PLAN.md(改画布前)。
- **老积压全景**:见 CLAUDE.md 第 5 节引用的 docs/IMPROVEMENT-PLAN.md;批次1/2/3 在集成线上全部未动(状态同 main),wrangler 漏洞已随依赖树消失。
- 上一阶段账号体系(W2~W4b)与画布四阶段的完整记录在 git log `6482277..f4b3ef3` 与 docs/ACCOUNT-PLAN.md / CANVAS-INTEGRATION-PLAN.md。
