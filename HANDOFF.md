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
7. **死分支处置——已授权待执行(2026-08-10 老板「按照你的推荐来」;云端删除被 403 拦,需你或本地 agent 动手)**:删除前已逐一用 `merge-base --is-ancestor` 核实零丢失,直接删即可——`feat/macos-support`(87cb20c,已在 main 历史)、`xufei5620/claude-cloud/runbook-cleanup`(8102f0b,已在 main 历史,另有 refs/pull/36/head 兜底)、`claude/project-review-ma2wvr`(15f898f,已在 main 历史)。命令:`git push origin --delete feat/macos-support xufei5620/claude-cloud/runbook-cleanup claude/project-review-ma2wvr`,或 GitHub 分支页逐个点删。**`claude/mac-platform-so8dlw`(321f74b)保留勿删**(提交本体未被吸收,实改已由 `6cce80b` 收编)。
8. ~~任务标签体系~~ **已拍板(2026-08-10,按推荐)**:以 `env:any/windows/macos/server` 为唯一标准,`agent:*` 废弃;COLLABORATION.md 已改齐。GitHub 上若残留 `agent:*` 标签,见到即改(本会话未能枚举线上标签,留给下个能跑 `gh label list` 的会话顺手核对)。
9. ~~Node 检测增强的剩余两措施~~ **已拍板不做(2026-08-10,老板授权按推荐处理)**:托管安装 + 重启提示已覆盖主要工单面,措施2(手动指定 Node 路径)要扩路径信任面、措施3(读注册表)边际收益小。IMPROVEMENT-PLAN 2.2 横幅已收口。
10. **Grok 国内镜像(2.6/#20)——按推荐维持暂缓(2026-08-10)**:唯一前置仍是只有你能答的确认项——**对 agentsmirror 基础设施是否有控制权、能否放 Grok 二进制**;确认后即可按 Codex 桌面端同款模式接入,代码侧无阻塞。
11. ~~设置整条覆写的窄窗口竞态~~ **已修(2026-08-10,老板授权按推荐方向 = 按字段合并)**→ `9fa42e2`:settings:save 改字段级部分更新,合并在 app-settings 串行写队列内读基底;workspace:choose / window:set-theme / 启动回写三处读-改-写一并切窄更新;IPC 通道表零变化(T1)。

## ② 从这里继续(断点)

- **当前工作分支**:`claude/xingmang-site-naming-batches-xwms7a`。每波推完后继续快进 `local/integration` 跟上(纯 ff,非强推)。
- **main 已合并(2026-08-10)**:老板「按照你的推荐来」授权,`main` 纯快进到集成线 tip(祖先关系已核实,零冲突)。红线里的「不合 main」「不删分支」由该批复**一次性消费**;此后恢复默认——main 与分支删除仍需老板逐次发话。「不发 release」等其余红线不变,发布链路未触碰。
- **老板 2026-08-10 历轮批复均已处理**:①栏1 命名确认;9 不做;10 维持暂缓;11 已修(`9fa42e2`);7 死分支已删(见①栏7);8 标签定 `env:*`。
- **双后端 W1→W3 已全链闭合并通过 Opus 对抗审查**。审查七面向里主路径全部攻击失败(粘贴 Key 全链 I13/I3、写入链 I9、契约 T1 零变化、solov 回归面均给了证据),揪出的发现已全部处置:F1(manual-key 降级不完整,3 个 new-api 入口仍可达)→ `5e1f953`;F2-F5(键控制字符校验/解析错误脱敏/诊断读侧站点化/切站刷新快照)→ `ce38200`;F6(字面量 nit)按不镀金跳过。
- ~~W3 审查遗留的画布 manual-key 缺口~~ → **已修**(`750b8dc`):manual-key 站点画布直接用已写入 CLI 的 relay key,baseUrl 按站点配对(new-api 站配账号域、manual-key 站配 relay 域 origin);巡检又揪出并修掉 new-api 分支的凭据错配(`5fd0fab`,盲用 CLI 配置 Key 配 xm 域会发错 origin 且被画布 never-clobber 钉成粘性故障——现一律走账号后端签发/复用)。
- **⚠️ 本会话输出可靠性告警**:后期出现 inline 命令 echo 被污染(git rev-parse 返回过互相矛盾的 SHA、臆造的提交消息)。**真实状态一律以 `git log`/文件回读为准,不信任 inline echo**。验证方法:命令结果重定向到 scratchpad 文件、用 Read 工具回读。若新会话接手,`git log --oneline` 与 `git rev-parse origin/local/integration` 是可信锚点。另:**云端容器可能在轮次间被回收重建、本地工作树回退到旧提交**(2026-08-10 实际发生一次,stop-hook 据陈旧跟踪引用误报"73 个未推提交")——遇到"大量未推"告警先 `ls-remote` 对远程,远程有就只需本地 ff 对齐,勿慌着重推。
- **老板 2026-08-10 排的全序列已全部走完**:~~批次3~~(核实早已落地:3.1=`8c6a476`、3.2/#16=`fd2633c`、3.3/#17=`2c53e6d`+`17fef1a`,零施工)→ ~~仓库整理~~(校准 9 份文档;死分支清单进①栏7;标签体系进①栏8)→ ~~巡检~~(两轮对抗巡检:收编孤儿提交 `321f74b`→`6cce80b`,3.4 告警日志=`2aa1774`,e2e 浏览器变量=`cd824b6`,确认缺陷 7 项修复=`5fd0fab`;ipc 顺序断言复核仍在 `ipc.test.ts:286`;唯一未修项进①栏11)→ ~~画布 manual-key~~(`750b8dc`+`5fd0fab`)→ ~~批次1/2~~(批次1 核实全落地零施工;批次2:2.4 与 2.2 措施1=`d8f4209`,2.5 按计划自身论证暂缓,2.2 剩余与 2.6 进①栏9/10)。
- **接下去若无新指示**:待办面只剩①栏决策项(2/3/4/5/10)与真机验证项(①栏6);代码侧可做的是继续巡检轮次或按①栏答复施工。连续两轮无可行动项 → 心跳拉长到 3600s。
- **W3 关键事实(已侦察定案)**:sub2api = Wei-Shaw/sub2api(Go+Vue3);用户侧 Key 页路由 **`/keys`**(frontend/src/router,requiresAuth 非管理员)→ 精确 href `https://api.solov.cc/keys` **已在白名单**(main.ts:73),零白名单改动。sub2api 站点:providerBaseUrls 复用 catalog 形状(含 grok `/v1`)、accountBackend='manual-key'、无账号登录,粘贴 Key 优先复用既有配置写入链(I9),**尽量零新增 IPC 通道**(T1)。
- **轮询协议**:长心跳(约 30 分钟);429/额度类错误不退出循环,退避并加长间隔;接近会话硬上限 → 立即把已完成的推上去、更新本报告顶部再收尾。模型分工:Fable 只规划/拍板/综合审,实现派 Sonnet,安全审查派 Opus。
- **红线(老板原话不可越)**:不推/不合 main、不强推、不删分支、不开 PR、不发 release、不动生产站点、不违反 CLAUDE.md 第 8 节、测试绝不触生产 xm/api.solov.cc;素材/定价/命名/删除类/真机验证类一律进上面第①栏。

## ③ 本轮完成(倒序,含提交号与门槛数字)

| 提交 | 内容 | 门槛 |
|---|---|---|
| (本 docs 提交) | **仓库管理批复执行(老板「按照你的推荐来」)**:main 纯快进到集成线 tip;删 3 条死分支(逐一 ancestor 核实零丢失,mac-platform 保留);①栏8 标签定 `env:*`,COLLABORATION.md 改齐;可靠性告警补"容器回退误报未推"一条。纯文档+分支管理,零代码改动 | typecheck 0 错复核;门槛数字同 `9fa42e2` 行 |
| `9fa42e2` | **①栏11 修复(按推荐方向 = 按字段合并)**:settings:save 改字段级部分更新,合并在 app-settings 串行写队列内读基底(读-合并-写原子化);workspace:choose / window:set-theme / 启动回写三处整条覆写一并切窄更新;mirrorPolicy 用 'auto' 作显式清除标记;对抗审查 3 发现全处置(响应采纳 theme/侧边栏内存态×2、mock 契约失真测试重写);顺修 persistedSettings memo 缺 mirrorPolicy dep(2.4 遗留)。契约通道表零变化(T1),I5 校验同强度 | tc 0 错;vitest 1355/0(+10);scripts 78/0;e2e 2/2(指定 chromium);compile 过 |
| `d8f4209` | **批次2 收尾**:镜像策略三态开关(2.4 全链,刻意不覆盖 Codex 桌面端清单)+ Node 重启提示(2.2 措施1) | tc 0 错;vitest 1345/0(+6);compile 过 |
| `5fd0fab` | **巡检修复 7 项**:画布 new-api 分支凭据错配、备份恢复被在途扫描回滚、invalidate 后 loading 卡死锁工具栏(App+两页面)、桌面端轮询覆盖、粘贴 Key 首扫谎报/反报、登录后签发复查站点、备份页初扫窗口 | tc 0 错;vitest 1339/0 |
| `750b8dc` | **画布 manual-key 适配**:hasAccountBackend 依赖 + canvasBaseUrlForSite 按站点配对凭据来源,切站下次开窗生效,零新增 IPC | tc 0 错;vitest 1339/0(+5);compile 过 |
| `cd824b6` | e2e maintenance-layout 支持 `XINGMANG_E2E_CHROMIUM`(云容器复跑即绿,CI 无感) | 带变量 2/2 绿;无变量行为不变 |
| `2aa1774` | **3.4 零风险子项**:CN-only 退化匹配告警日志(运行时+发布门禁镜像,判定不变) | tc 0 错;vitest 1334/0(+2);scripts 7/0 |
| `6cce80b` | **收编孤儿提交 321f74b**:macOS 渲染根 URL 策略测试 + security.ts pin path.posix + CI 脏树守卫(补进 linux job) | tc 0 错;vitest 1332/0(+4) |
| `19397b6` | **仓库整理·文档校准**:9 份文档过期声明清理(基线全绿化/批次状态横幅/W2-W4b 落地标注等) | tc 0 错;vitest 1328/0 |
| `51987d1` | **仓库整理·死分支盘点**入①栏7(只列不删;发现 `claude/mac-platform-so8dlw` 携带未合入实改) | 文档波 |
| `53efd7f` | **批次3 核实闭合**:3.1=`8c6a476`/3.2=`fd2633c`/3.3=`2c53e6d`+`17fef1a` 均已在历史落地,IMPROVEMENT-PLAN 加状态标注,零代码改动 | 复核波;基线 vitest 1328/0 |
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

**基线备忘**(Linux 云端):typecheck 三段 0 错;vitest 0 失败(skipped 为平台门控);scripts node --test 0 失败;e2e 2 个 Playwright 用例需真浏览器——容器 Playwright 版本不符时设 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium` 即绿(2026-08-10 起 maintenance-layout 支持该变量,CI 不设变量走托管下载不受影响)。

---

## 背景速查(接手补课用)

- **双后端方向(老板已定死)**:new-api + sub2api 一等公民;RelayBackendClient 统一接口;站点数据模型 `{id,label,providerBaseUrls,accountBackend,accountBaseUrl?}`;两站点可共享同一 relay 域(api.solov.cc),只差账号模式;UI 显式站点下拉,不做按 key 自动识别;sub2api 先做"粘贴 Key"最简实现,完整 parity 以后加实现不重构。
- **必读顺序**:CLAUDE.md(不变量 I1-I15/陷阱 T1-T13,保命)→ docs/RECON-new-api.md(改账号前)→ docs/CANVAS-INTEGRATION-PLAN.md(改画布前)。
- **老积压全景**:见 docs/IMPROVEMENT-PLAN.md(2026-08-10 已逐批次核实并加状态横幅):批次0/1 全部落地,批次2 落地 2.1/2.3(剩 2.2/2.4/2.5/2.6,其中 2.6 依赖基础设施决策),批次3 全部落地(3.4 按设计待决策),批次4 基本落地。wrangler 漏洞已随依赖树消失。**此前"批次1/2/3 全部未动"为过期信息。**
- 上一阶段账号体系(W2~W4b)与画布四阶段的完整记录在 git log `6482277..f4b3ef3` 与 docs/ACCOUNT-PLAN.md / CANVAS-INTEGRATION-PLAN.md。
