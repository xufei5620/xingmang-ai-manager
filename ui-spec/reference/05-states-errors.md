# 05 · 状态、错误与恢复 v3.0

每个任务有可追踪的开始、进行、终态和返回位置。状态来自同一业务对象，首页、详情、通知与状态栏订阅同一结果。原型定时器只用于演示节奏，真实实现由任务/接口/系统回执驱动。

## 1. 通用状态结构

建议 UI 适配结果包含：对象ID、所属账号/Provider/窗口、阶段、已确认值、草稿、错误代码与友好说明、允许动作、请求/任务ID、更新时间、来源入口。字段是界面契约，不规定后端命名或端点。

| 状态 | 呈现 | 可用动作 / 保留数据 |
|---|---|---|
| idle | 当前对象和下一步 | 开始/添加/选择 |
| loading | Skeleton或有名称的阶段 | 可取消时提供取消，保留已有数据 |
| ready | 已确认结果 | 后续业务动作 |
| empty | 原因和第一步 | 添加或使用工具；不伪造内容 |
| filterEmpty | 没有匹配结果 | 清除筛选，保留原数据 |
| error | 影响、输入是否保留、下一步 | 重试/查看帮助/返回原任务 |
| readonly | 可查看但不能修改及原因 | 查看/导出等实际允许动作 |
| unavailable | 不支持、未安装、缺权限等明确原因 | 平台替代或准备入口 |
| cancelled | 已停止的阶段 | 重新开始；不要声称自动回滚 |
| partial | 完成与未完成对象分开 | 只重试失败项或查看恢复信息 |

错误紧邻原任务容器，重要错误不只放Toast。未知字段用“暂未获取”，不能转换成零、未安装或已失效。禁用标签仍可读，同时说明可恢复路径。

## 2. 关键状态转移

以下是UI阶段契约；组合步骤名不强制成为实现枚举。模块中实际字段、动作和状态名称见15。

| 域 | 转移与终态 | 恢复约束 |
|---|---|---|
| 注册登录 | editing → submitting → signedIn；或registered/loginFailed；或fieldError | 注册成功后尝试自动登录；失败预填用户名，不能承诺已建全部Key |
| 准备引导 | choose → detect/install → connect → ready；failed/partial留当前步 | 返回保留路线与来源，官方来源不被星芒默认覆盖 |
| 工具配置 | draft → saveMode → saving → saved；saveFailed | 合并/重置分开；失败不清草稿；已保存但重启失败独立呈现 |
| 运行 | stopped → starting → running；startFailed；running → restarting → running/restartFailed | 描述当前是否仍在运行，配置提交不能冒充启动完成 |
| 安装 | checking/downloading/installing → installed；cancelling → cancelled；failed | 总量未知只显示阶段，取消不能直接声称旧版本已恢复 |
| 外部安装 | instructions → waiting → detecting → found/notFound | “我已安装”只触发检测，不直接标成功 |
| Key | active/disabled/expired/exhausted | 停用可重新启用，过期修改有效期，耗尽调整额度；不得合成“已撤销” |
| OAuth | signedOut → 授权任务running → signedIn；failed/expired/cancelled | 返回连接/工具原上下文，重试不丢Client ID等草稿 |
| 扩展启停 | confirmed → saving → newConfirmed/failed | 失败回原开关值，未知能力不可假定可写 |
| 备份恢复 | preview → snapshot → validate → apply → verify → done | 校验失败不写入；部分失败保留原件/快照；恢复未完成不显示成功 |
| 更新 | idle → checking → latest/available → downloading → downloaded → installConfirm | 下载失败重下，检查失败重查；取消、安装失败保留当前版本 |
| 设置 | confirmed → preview/saving → saved/failed | 开关失败回退；文本保留attempt；并发同字段最新操作胜出 |
| 迁移 | idle → running → done/failed/cancelled | 原快照保留，失败不切读取路径 |
| 回滚 | snapshotNew → rollingBack → rolledBack/rollbackFailed/cancelled | 保留新版数据与快照，不能以旧文件仍在代替新数据保护 |
| 画布保存 | saved → dirty → saving → saved/failed | 保存/运行期间锁相关编辑，失败留图可重试；成功只代表本次演示快照 |
| 画布运行 | idle → invalid或running → stopped/failed/done | 校验定位节点，停止递增操作ID使旧回调失效；结果为本地构图 |

## 3. 支付与账户

报价与订单分开：选择 → 获取报价 → 报价有效/失效 → 创建订单 → 等待付款。订单 pending → querying → paid / failed / unknown / timeout。关闭付款页保持订单与所属账号；浏览器回跳仅触发查询。paid 仅由权威查询结果确认，重复查询不重复到账。

余额、订阅、Key额度、官方额度是四套不同限制。账户余额为零不能禁止使用有效订阅或官方账号；四种扣费偏好见09。接口失败不能归为余额不足。

切换账号：准备快照 → 验证目标 → 切换 → 逐工具同步 → 完成/部分同步。目标过期时保留当前账号；成功后不同账号的Key、订单、用量、任务、设备、会话和草稿隔离。旧请求/迟到回包携带所属账号，不进入当前界面。

## 4. 聊天错误词典

| 原因 | 对用户的说明与下一步 |
|---|---|
| offline | 网络暂不可用；保留输入，检查网络后重试 |
| expired | 登录已过期；重新登录后回原会话 |
| timeout | 本次请求没有完成；保留内容，可重试 |
| rate | 请求较频繁；稍后重试，真实等待时间由结果提供 |
| model | 当前模型暂不可用；选择其他模型后重试 |
| balance / capacity | 当前扣费方式下额度不足；查看余额/订阅/偏好 |
| copy failed | 自动复制不可用；打开可选文本并说明系统复制快捷键 |

停止、删除会话、切换账号、重置演示场景均使旧请求令牌失效。重试保持原用户消息，生成新的请求尝试；真实重试/扣费由服务契约保证幂等，前端不自造扣费成功。

## 5. 关闭、取消与提示

最上层浮层独占Esc；有草稿显示继续编辑/放弃修改。取消任务后确认已停止、停止中或当前阶段不可中断；不要先关弹窗再让用户找不到后台任务。进行中的订单可关闭并从订单页恢复。

无托盘保留窗口；无通知服务用应用内Notice/状态页；剪贴板失败给可选文本；没有桌面端走CLI/聊天；外部安装返回检测。平台名称不能代替能力检测。

错误报告先脱敏再预览、复制和导出。保留Key字段名但遮盖值，清理令牌、Authorization、Cookie、密码和路径用户名。不得因生成报告自动发送。

画布离开统一经canvasNavigate；运行中可继续或停止并继续，dirty可取消/放弃/保存并继续。A.canvasHasPending()包含dirty、saving与running，主窗口使用canvasCloseThen在保护完成后继续；取消清回调，S变化时旧回调无效。导入失败保留粘贴内容，导出JSON不清除dirty且不表示写入真实工程。

## 6. 场景登记与验证

30模块提供五页面×六通用状态，并组合Provider与业务能力场景；10/20/40/50/80/85各有专项场景，95只是窗口外的快捷入口。场景数与测试通过数不能相互替代。按 [10](10-acceptance-checklist.md) 实际执行，失败记录对象、触发步骤、预期与实际、修复后复跑，最终证据见 [16](16-final-validation.md)。
