# 滚动报告(无人值守自主轮询)

> 本文件 = 云端 agent 的滚动交接报告,**每完成一波就更新并随代码推送**。
> 接手协议:任何新会话 `git checkout local/integration` + 读本文件顶部三栏即可无损继续。
> 与 CLAUDE.md 或代码冲突时,以代码为准。上一版 HANDOFF(2026-08-10 静态交接稿)已由本报告取代。

---

## ① 等老板拍板(全部跳过不猜,按下列编号答复即可)

1. **站点下拉命名**:占位「星芒·账号站」(new-api / xm.solov.cc)与「星芒·Key 直连」(sub2api / api.solov.cc)——措辞待确认。
2. **勘合遗留**:xm.solov.cc 签发的 key 在 api.solov.cc relay 上是否真能推理成功——生产验证类,agent 不碰生产,等你真机验。
3. **客服素材**:欢迎页企业微信二维码仍是占位图(`WelcomePage.tsx` 有 TODO),等正式素材(一次静态替换 + 白名单一行)。
4. **试用额度**数字 + new-api 后台配置;余额告警阈值 $5 是否认可。
5. **注册方式扩展**:微信需开放平台应用、GitHub 需配 OAuth——要你去申请,代码侧不阻塞。
6. **A 真机验证清单**(只能你走):账号后半程(重启保持登录/token 续期/收重置邮件/个人中心真实数据);Key 管理表 7 列一屏不溢出;正常环境点开画布看观感;改密码「原密码错误」文案实测。
7. (占位)死分支处置建议——②仓库整理时补全清单,只列不删。

## ② 从这里继续(断点)

- **当前进行中**:W2 已提交(见③栏),Opus 对抗审查已派出/待派——审点:I10(站点 URL https)、I12(白名单派生与旧手写集合全等)、I6(relaySites 值导出链)。有发现即追加修复提交。
- **之后顺序**:**W3**(relay-sites 加 sub2api 条目 + 粘贴 Key 流 + 设置页站点下拉 + 账号区按 capability 降级;⚠️ W3 必做:`inspectProviderConfig` 读侧对账切到活动站点,并同步更新 `system-service.test.ts:302` 那条 2 参断言——W2 因"不动既有断言"红线刻意缓切,单站点下值相同无行为差)→ **D 批次3 两安全项**(#16 Codex 归档硬链接死锁、#17 发布门禁 fail-open→fail-closed)→ **② 仓库整理**(文档校准/杂物归位/.gitignore 查漏/死分支清单)→ **③ 持续发现-修复**(代码缺陷 + 功能/设计问题都在范围;每个候选先对抗验证再动手;连续两轮无可行动项 → 拉长巡检间隔)。
- **W3 关键事实(已侦察定案)**:sub2api = Wei-Shaw/sub2api(Go+Vue3);用户侧 Key 页路由 **`/keys`**(frontend/src/router,requiresAuth 非管理员)→ 精确 href `https://api.solov.cc/keys` **已在白名单**(main.ts:73),零白名单改动。sub2api 站点:providerBaseUrls 复用 catalog 形状(含 grok `/v1`)、accountBackend='manual-key'、无账号登录,粘贴 Key 优先复用既有配置写入链(I9),**尽量零新增 IPC 通道**(T1)。
- **轮询协议**:长心跳(约 30 分钟);429/额度类错误不退出循环,退避并加长间隔;接近会话硬上限 → 立即把已完成的推上去、更新本报告顶部再收尾。模型分工:Fable 只规划/拍板/综合审,实现派 Sonnet,安全审查派 Opus。
- **红线(老板原话不可越)**:不推/不合 main、不强推、不删分支、不开 PR、不发 release、不动生产站点、不违反 CLAUDE.md 第 8 节、测试绝不触生产 xm/api.solov.cc;素材/定价/命名/删除类/真机验证类一律进上面第①栏。

## ③ 本轮完成(倒序,含提交号与门槛数字)

| 提交 | 内容 | 门槛 |
|---|---|---|
| (本次) | **双后端 W2**:relay-sites.ts 站点注册表(零依赖,solov 单条目)+ AppSettings.relaySiteId(坏值降级默认)+ 8 处硬编码消费点切站点解析(配置写入/模型列表/诊断探测/白名单派生/渲染层三链接)+ 契约值 re-export(providerIds 先例)。e2e 零改动=默认行为不变的验收 | tc 0 错;vitest 1299/0 失败(基线+16);compile 过(I6 无 node 依赖入渲染包) |
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
