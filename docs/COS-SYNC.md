# 安装包自动同步到腾讯云 COS

COS 的主要用途是下载星芒 AI 管理工具。Codex 桌面端和 Claude 桌面端的官方离线包只用于备用救急，例如正常安装失败或网络异常；星芒工具内默认仍使用现有的正常安装和下载方式，不切换到 COS。

教程可见名称使用「Codex 桌面端」，OpenAI 官方包的内部 `chatgpt` 目录、文件名和产品清单标识保持兼容。

这份配置把三个产品的文件保存到同一个下载桶。开关默认关闭，配置完成后再开启。

当前目标：`xingmang-downloads-1342302199`，地域 `ap-shanghai`。客户用 COS 默认 HTTPS 地址下载，上传凭据只在 GitHub Actions 中使用。

## 三个产品的同步流程

| 文件来源 | 触发方式 | 下载索引 |
| --- | --- | --- |
| 星芒 AI 管理工具 | `publish-release` 正式发布完成后，显式执行 COS 同步 | `xingmang/latest.json` |
| 官方 ChatGPT 桌面备用离线包 | 每 6 小时检查一次；也可手动运行 `sync-chatgpt-official-cos` | `chatgpt/latest.json` |
| 官方 Claude 桌面备用离线包 | 每 6 小时检查一次；也可手动运行 `sync-claude-official-cos` | `xingmang/offline/claude/latest.json` |

星芒用 `GITHUB_TOKEN` 创建 GitHub Release，不能依赖这个事件再触发一个 `release: published` 工作流。同步步骤直接接在既有发布作业末尾，保留 `release` 环境的发布批准和 `update-feed` 串行规则。

星芒同步本次完整发布产物，包括安装包、Mac 更新 ZIP、blockmap 和 `latest*.yml`。按平台清单校验版本、文件名、大小与 SHA-512，再上传到 `xingmang/releases/<星芒版本>/`。单平台发布时，索引保留其它平台已经发布的下载；同版本补发另一平台会合并条目。同版本同文件名而内容不同的文件不能覆盖。

官方同步的 `all` 模式覆盖：

- Windows x64、ARM64：完整 MSIX 与离线许可；核对产品身份、四段版本、架构、Publisher 和 Windows Authenticode 有效签名。
- Mac Apple Silicon、Intel：读取官方 Sparkle appcast 的主 enclosure，保存完整应用 ZIP。排除增量文件，使用官方清单实际给出的 URL；不拼猜未来 DMG 地址。这些 ZIP 可用于完整应用分发，不能描述成 DMG。
- Linux x64、ARM64：官方 DEB、RPM。

Mac/Linux 当前记录官方 HTTPS 来源、格式和完整 SHA-256 校验，没有声称已完成这些平台的应用签名或安装验收。每个平台单独记录自己的来源版本或指纹，不把 Windows 的版本号当成其它平台版本。

Claude 同步在 Windows、macOS、Linux 各自的原生 runner 上验证，同一工作流的三个平台作业串行维护索引。Windows x64/ARM64 保存官方完整 MSIX，不使用 setup 引导安装器，也不套用 OpenAI 的许可；Mac DMG/PKG 是兼容 Apple Silicon 和 Intel 的通用包；Linux beta 使用官方 APT 元数据所列的 x64/ARM64 DEB，不提供未经核实的 RPM。

Claude Windows 检查 MSIX 产品身份和有效 Authenticode；Mac 原生读取应用/PKG 元数据并核对签名；Linux 核对官方索引大小、SHA-256 和 DEB 包头，记录未执行 APT GPG 验签。文档中的下载接口已核实，真实版本、最终 CDN、签名及安装结果以首轮 Actions 验收为准。

Claude Windows 固定 `latest/redirect` 入口使用匿名 GET，仅读取响应头后立即销毁正文；最终静态包仍使用 HEAD 获取大小与 ETag。2026-10-03 GitHub runner 公开探测确认 Windows 两个入口拒绝 HEAD（405），GET 则返回 307 到已允许的 `downloads.claude.ai/releases/`。

Claude Mac 的这两个浏览器下载入口在 runner 返回 403，并明确带有人机验证标记；同步器不会处理或绕过该验证。Mac 来源改用官方客户端公开 SDK 所使用的正常匿名更新协议：在原生 macOS runner，固定访问 `api.anthropic.com/api/desktop/darwin/<实际架构>/squirrel/update`，携带本次同步器自行生成的临时安装 UUID、已验证种子版本及 `sw_vers` 产品版本。不读取用户设备身份、账号配置或认证 Cookie；UUID 不出现在日志、COS 清单或公开下载页面。

官方更新 JSON 的 `currentRelease` 必须对应唯一 `releases[].updateTo`，其中完整 Universal ZIP 的无查询参数地址、声明大小及 SHA-256 都须通过固定 schema。用该 Mac 发布版本和 release ID 构造两个独立的 DMG/PKG 候选地址；这个格式对应关系来自实际官方下载样本，并非厂商承诺的长期跨格式接口。任何候选不存在、官方元数据或包内版本变化，都停止发布并保留原 latest。ZIP 的 SHA-256 只作元数据溯源，不作为 DMG/PKG 的文件摘要。

当前 `2.19675.0` 的两个候选还分别绑定正常官方浏览器下载后计算的大小和 SHA-256，依据保存在 `claude-mac-confirmed-sources.cjs`。将来官方更新 feed 给出新版本时自动解析新候选，不套用旧版浏览器摘要。DMG/PKG 均完整下载、原生验签后才可上传：固定 `Anthropic PBC`、Team `Q6L2SF6YDW`、Apple 根链和应用标识；PKG 还展开实际 payload，验证其中唯一应用的签名、Info.plist 版本及 Intel/Apple Silicon Mach-O。包壳的 PackageInfo 版本和 URL 中的 universal 字样不能代替这两项验证。

发布 latest 前，使用本次同一个匿名安装 cohort 重新请求官方 feed，并重查候选 HEAD；版本、release ID、声明 ZIP 指纹或候选大小/ETag 变化时不切换指针。同步日志只含固定阶段、平台、耗时、字节数和自有脱敏错误分类；latest 写入结果未知时独立读回确认，不自动重试、覆盖或回滚，清理失败也不会掩盖此前的主错误。

Claude 备用文件保存在 `xingmang/offline/claude/<平台>/sha256-<摘要>/`，不可变候选清单保存在同一前缀的 `indexes/`。它们与星芒正式发布的 `xingmang/releases/` 和 `xingmang/latest.json` 分开，使用现有 `xingmang/*` 授权即可同步，无需扩大 CAM 权限。

官方源没有变化且已验证的 COS 对象指纹也没有变化时，跳过大包下载。没有经过校验的旧索引时，先完整下载官方原包；手动上传的同名对象必须与原包完整字节一致才可复用。

## 1. 准备 COS 上传身份

1. 在腾讯云 CAM 创建专用于安装包同步的子账号，并为其准备 API 访问凭据。
2. 创建自定义策略，使用 [cos-sync-policy.json](cos-sync-policy.json)。这份策略仅允许当前桶的 `xingmang/*` 和 `chatgpt/*` 两个前缀执行 GetObject、HeadObject、PutObject，Claude 备用包属于 `xingmang/offline/claude/`。
3. 把策略关联给该子账号。同步脚本不需要删除文件、修改 ACL、管理存储桶或操作其它云产品的权限。
4. 存储桶使用标准存储、公有读私有写，版本控制保持关闭。不可变版本目录和 `x-cos-forbid-overwrite` 用于防止包被覆盖；COS 的这项防覆盖头在开启桶版本控制后无效。

SecretId 和 SecretKey 直接填写到下节 GitHub Secrets，不经过聊天、源码、公开清单或工作流日志。

## 2. 配置 GitHub 环境与 Secrets

仓库：`xufei5620/xingmang-ai-manager`。

在 **Settings → Environments** 中配置：

| 环境 | 用途 | 保护规则 |
| --- | --- | --- |
| 既有 `release` | 星芒完成正式发布后同步 COS | 保留原有 required reviewers 和发布批准 |
| 新建 `cos-sync` | 官方包的自动检查和同步 | Deployment branches 限定 `main`；不设置每次人工批准，否则定时任务会停在等待批准 |

在两个环境的 **Environment secrets** 中分别设置：

- `COS_SECRET_ID`
- `COS_SECRET_KEY`

同一个受限 COS 子账号可用于两个环境。保留原有 R2 和 Mac 签名 Secrets。

在 **Settings → Secrets and variables → Actions → Variables** 配置仓库变量：

| 变量 | 当前值 |
| --- | --- |
| `COS_BUCKET` | `xingmang-downloads-1342302199` |
| `COS_REGION` | `ap-shanghai` |
| `XINGMANG_COS_SYNC_ENABLED` | `true`，在环境及 Secrets 配齐后开启 |

Bucket/Region 可省略并使用上述默认值。首次上线前应先检查 `cos-sync` 环境的分支限制；自动创建的同名环境没有这些保护规则。官方同步还会检查仓库身份、`main` 分支和开关，使用只读 GitHub token。

## 3. 首次运行及后续发布

### 首次导入已发布的星芒安装包

运行 `sync-published-manager-cos`，选择 `main`；留空版本号导入最新正式 GitHub Release，也可指定正规发布标签。仅接受同一仓库的正式发布和安装包资产，下载后核对 GitHub 提供的大小及 SHA-256，再按安装包模式同步 COS。该模式不重新发布星芒、不修改 R2，也不伪造 GitHub Release 中没有的更新 companion 文件。未来正式发版仍同步完整发布产物。

观察 `[manager-sync]` 的固定阶段：GitHub 发布清单、下载位置、安装包下载/摘要、COS 文件完整回读、候选索引、latest 切换及清理。失败只输出阶段、已验证版本/平台和安全白名单分类；HEAD 探测分别标记超时、网络失败、HTTP 状态和被拒的重定向原因，绝不输出原异常、堆栈、文件路径、URL、Location 或认证正文。`not-written-by-this-run` 不表示此前的不可变文件未上传；`write-unconfirmed` 需要先读取远端状态；`published-and-read-back` 表示 latest 已完整回读确认，即使之后清理临时目录失败。清理错误单独记录，不盖掉原始同步失败；分块仅对下文列明的超时有限重试，其它写入不自动重试。

### 官方 ChatGPT 包

#### 大包分块上传（默认关闭）

真实运行中，官方源下载正常而 COS 单连接 PUT 约为 50 KiB/s，大包可能超过既有上传期限。实现提供分块上传，而不是增加原 PUT 超时：`XINGMANG_COS_MULTIPART_ENABLED` 缺省或 `false` 保持原流程。负责人现场确认权限及存储桶版本控制关闭后，才在受保护环境设置为 `true`；本改动不修改线上变量、凭据或权限。

启用后，16 MiB 及以上的不可变文件使用 4 MiB 分块；并发数 `XINGMANG_COS_MULTIPART_CONCURRENCY` 限定 4–8，默认 8，分块缓冲最多 32 MiB。小文件、JSON 和三个固定可覆盖的 latest 指针继续使用既有单次 PUT。上传先在同一个可信已打开文件句柄上核对完整 SHA-256，逐块 SHA-256 绑定实际发送内容，按 COS 协议签入查询参数与 Content-MD5。每块响应头等待至多六分钟，显式设置的更短调用方超时仍优先；分块调度总期限七十五分钟（已发出的请求收拢后退出），合并正文至多十分钟，各平台作业仍限九十分钟。每次请求重新生成有效期三十分钟的签名，覆盖单块请求；整体调度不会复用一份过期签名。

2026-10-03 的两个真实运行均在 4 MiB 单块等待响应头三分钟后失败：八并发运行 `37103271602` 在约 244 秒提交 58,720,256 字节，四并发对照 `37119586459` 在约 611 秒提交 96,468,992 字节，两次均未开始 Complete 且公共 GET 为 404。减并发未解决单块超时，因此提高这两项时间上限，以容纳近期约 900 MB 包的较慢传输。七十五分钟是分块调度上限，并非整个同步的保证耗时；源下载、在途请求收拢、合并及完整公共回读仍受各自预算和九十分钟作业硬期限约束，实际吞吐与成功率须继续用真实运行验收。

同日六分钟预算运行仍出现分块 HTTP 400；原日志没有 COS 错误码，不能将其认定为 RequestTimeout。现在仅对固定 COS HTTPS 域名的分块请求读取错误正文，限制为 4 KiB 和五秒（更短调用方正文预算优先），只从严格 XML 的唯一顶层 Code 提取固定白名单 `cosErrorCode`，不记录 Message、Resource、RequestId、TraceId、正文或认证数据。解析失败、超限、慢正文和断流仍保留原 HTTP 状态；重定向不读取或跟随。

同一 UploadId、partNumber 和已通过 SHA-256 校验的 Buffer，仅遇响应头/正文超时、网络 ETIMEDOUT，或安全识别为 HTTP 400 RequestTimeout 时，最多额外重试两次。每次重新签名，并检查原七十五分钟截止和其它 worker 的失败状态；校验失败、证书错误、其它 HTTP 错误不重试。官方协议规定同一 UploadId/partNumber 的后一次上传覆盖前块，因此重发同一内容可恢复已保存但响应丢失的分块，无需额外 ListParts 权限。Init、Complete、Abort、普通 PUT 与 latest 均不增加重试。

仅需要在原有两个对象前缀范围增授四项 CAM action：`cos:InitiateMultipartUpload`、`cos:UploadPart`、`cos:CompleteMultipartUpload`、`cos:AbortMultipartUpload`。不需要 List、Copy、ACL、公开对象 DELETE 或扩大资源前缀。Init 与 Complete 都签入 `x-cos-forbid-overwrite: true`；官方文档明确该头不保护开启版本控制的桶，因此启用前必须核实桶版本控制仍为关闭。本模块不自行访问或修改桶配置。

Complete 的 HTTP 200 可能只是开始合并。代码等待有界完整正文并严格核对 XML 根、唯一字段及桶/对象身份，拒绝 Error、DTD/实体注入和重复字段。响应 Location 不用于下载，最终仍从固定 COS HTTPS 公共地址完整 GET 核对大小、SHA-256 和类型，成功后上层才可发布 latest。Complete 结果未知时不再 Complete、PUT、覆盖或回滚，也不中止可能仍在合并的会话；先回读，无法确认时停止并由负责人核实远程状态。分块失败只会在全部在途分块结束后 Abort 本次成功初始化且身份匹配的 UploadId；Abort 失败保留主错误，且不会删除公开对象。初始化回执未知时不猜测 UploadId 或列举其它会话，需负责人核查残留未完成分块。

协议依据：[初始化](https://cloud.tencent.com/document/product/436/7746)、[上传分块](https://cloud.tencent.com/document/product/436/7750)、[合并](https://cloud.tencent.com/document/product/436/7742)、[中止](https://cloud.tencent.com/document/product/436/7740)、[错误码](https://cloud.tencent.com/document/product/436/7730)、[上传概览](https://cloud.tencent.com/document/product/436/65935)。这是本地 mock 验证的能力，不能当作实际上传速度或生产权限已验收。

1. 合并工作流后，打开 **Actions → sync-chatgpt-official-cos → Run workflow**。
2. 分支选 `main`。首次及最终验收选 `all`，目标为八个平台包及两个 Windows 许可对象。选择器将其展开为八个固定平台作业，`max-parallel: 1` 顺次运行，各自保留 90 分钟期限及原 Windows 校验环境；整个工作流只有八项全成功才算成功。手动入口也支持 `windows`、`macos`、`linux` 和八个精确平台标识，便于定位单项故障。
3. 观察 `[chatgpt-sync]` 日志的阶段、平台、耗时、传输方法及字节数。首次会下载、校验和上传大包，后续没有变化时仅检查小清单与响应头。日志只输出固定阶段与白名单错误分类，不输出请求认证、签名 URL 或服务器正文。
4. 成功后访问 `https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/chatgpt/latest.json`，检查文件地址、大小、SHA-256 和验证范围。

已有手动上传的 `chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix` 及同目录许可可以保留；同步会校验完整内容后复用，不会把同名不同内容默默替换。

若运行已经写入部分不可变包、最后一个平台失败，先核对失败阶段和远端对象状态。可选精确标识（例如 `linux-rpm-arm64`）定位恢复，再运行 `all` 完成验收。单项同步会保留已有索引中的其它平台和许可；首次没有索引时，单项成功仅代表该平台已入库，不能当成八个平台全部成功。

每个平台验证和完整公共回读成功后才累计发布它自己的索引条目，因此八项不是同一个原子版本快照。首轮运行途中可暂时只有部分平台；后续失败保留已确认的其它平台，新 Windows 共享版本会按既有规则移除尚未刷新到新版本的另一架构，直到它自己的作业成功。两个 Windows 许可各随对应平台单独校验保存；其它平台的验证标签不升级为尚未完成的原生签名验证。所选作业全成功后，还会通过不带凭据的固定 HTTPS 公共读取与生产者 schema 验收最终索引；`all` 必须包含八个平台及配对的两份 Windows 许可，因长时间版本切换缺项时仍失败并保留部分索引，按精确平台恢复，不把八项曾经各自成功当作最终索引完整。

安全错误分类区分响应头超时、正文超时、HTTP 状态、断流、ETag/大小/摘要不一致，以及 PUT 与公共完整回读的各自原因。`latestState: write-unconfirmed` 表示最新索引写入结果未知，需要先读取远端状态；`published-and-read-back` 表示索引已发布并回读确认，即使随后临时目录清理失败。清理失败不会盖掉此前的主错误。

期限仍为 GET/HEAD 响应头 30 秒、GET 正文与普通 PUT 响应头 20 分钟、原生 Windows 检查 120 秒、整个作业 90 分钟；分块预算及有限超时重试见上文，日志计时使用单调时钟。最终切换索引前重新核对所选官方源的指纹及 Windows/Mac 元数据，避免长时间同步后将已经变化的 `latest` 源快照继续公布。其它写入不自动重试，也不调整上传身份的权限。

### 星芒正式发布

按既有发布手册运行 `publish-release` 并批准本次正式发布。COS 开关开启后，GitHub Release 创建完成即同步该次完整发布产物。Linux 是否正式分发仍由既有 `XINGMANG_PUBLISH_LINUX` 开关决定，不会通过 COS 绕过它。

成功后访问 `https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/xingmang/latest.json`。这一 JSON 索引使用绝对下载地址；版本目录里的原更新清单与安装包位于同目录。

### Claude 桌面备用包

打开 **Actions → sync-claude-official-cos → Run workflow**，分支选 `main`，首次选 `all`。也可只重跑 `windows`、`macos` 或 `linux`；平台作业保留索引中的其它已发布平台。成功后检查 `https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/xingmang/offline/claude/latest.json`。沿用现有 `xingmang/*` 的 GetObject、HeadObject、PutObject 权限和 GitHub Secrets，不增加 `claude/*` 授权或创建新密钥。

## 校验、顺序与失败恢复

- HTTPS 源站固定白名单，拒绝重定向，响应体有大小上限及 header/body 超时。
- 上传显式指定 Content-Type，包括 MSIX 的 `application/vnd.ms-appx`，避免 COS 默认识别为 `text/plain`。
- 先保存版本文件，通过公开地址完整读回、核对大小和 SHA-256。Windows 官方包在上传前还需要有效系统签名。
- 所需文件全部验证通过后，最后更新固定 latest 索引。旧版本对象保留；拒绝版本倒退和不可变路径的内容冲突。
- 同类工作流串行执行；切换前重读最新索引，发现变更则停止。人工 CLI 不应与 Actions 同时发布同类索引。本实现没有宣称普通 COS PUT 支持目标对象的条件写入/CAS。
- **切换前失败**：不会写 latest，可修复后重跑。
- **latest 写入结果未知**：先读取远端确认，不盲目覆盖或自动回滚；工作流失败时，检查索引和运行日志后决定重跑。网络错误不证明远端写入没有发生。
- 关闭 `XINGMANG_COS_SYNC_ENABLED` 可以停止后续同步，不会删除已上传版本。

## 最新学习空间和安装教程接入

2026-10-03 核实的实际教程来源是独立仓库 `xufei5620/codex-tutorial-cn`，Learning Studio v5.6。两站管理工具教程分别位于 `https://docs-new.solov.cc/guide/manager`、`https://docs-sub.solov.cc/guide/manager`；原 `dl-landing/` 是旧注册下载页，不能作为新版学习空间的实现来源。

客户端的手动下载入口指向 `https://docs-new.solov.cc/guide/manager#download-installers`。新版教程按产品、系统和架构直接提供下载按钮，读取对应 COS 索引，提供管理工具、Codex 桌面端和 Claude 桌面端的下载直链。Windows、Mac、Linux 只展示索引里实际已提供的平台；Codex Windows 许可与 MSIX 架构、版本对应，Mac 完整应用 ZIP 不称为 DMG；Claude MSIX 不需要该许可，Mac 的通用 DMG/PKG 不拆成虚构的独立架构包。

教程站使用已有 Cloudflare Pages 部署，通过三个限定的同源 Functions 路由读取 COS 索引。只获取固定桶的公开 JSON，不转发用户 Cookie、Authorization 或查询参数；请求和响应体均有上限。浏览器不需要 COS CORS 配置，下载文件直接来自 COS。

### 发布顺序

1. 先完成 COS 文件和三份索引上传，验证匿名访问、大小、类型与完整摘要。首次人工上传清单应与实际文件一致。
2. 在教程仓库验证两站真实构建、下载选择区和同源索引函数，再提交审查。该仓库 main 的既有工作流自动部署两个 Pages 项目；本仓不需要新增下载站 SSH 或 Nginx 配置。
3. 用户已授权完成检查后自行提交 PR 并合并，无需等待 Claude。合并时遵守仓库现有质量门禁；教程变更合并后分别验收两站的三组下载按钮，以及旧 `/guide/download` 路由的兼容跳转。
4. 教程入口上线后，再发布包含新手动下载地址的管理工具。随后启用 COS 同步工作流；后续版本只更新索引，教程按钮无需手工更换地址。

新版原有通用按钮曾取三个平台地址中的第一个，因此不能只把配置里的飞书 URL 分别换成安装包地址，否则 Mac 用户也会下载 Windows 包。新版接入按架构显式选择，通用入口定位下载选择区。

## 本次范围

这里建立自动存储、手动文件下载和下载页安装教程流程。现有星芒客户端的自动更新源、Codex 桌面端自动安装镜像、R2 发布与回滚流程继续使用既有配置。

COS 的独立星芒下载索引尚未跟随 R2 的版本撤回、回滚和维护状态同步。在把它作为客户端自动更新源之前，必须补齐这些控制和客户端源白名单，并在无微软商店环境验收安装。对象下载测试不等于安装成功，也不代表全国不同运营商的速度。

## 参考

- [GitHub token 的工作流触发限制](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)
- [COS 请求签名](https://cloud.tencent.com/document/product/436/7778)
- [COS PUT Object](https://cloud.tencent.com/document/product/436/7749)
- [COS 权限管理](https://cloud.tencent.com/document/product/436/56637)
- [OpenAI Windows 离线部署](https://learn.chatgpt.com/docs/enterprise/windows-deployment)
- [Claude Windows 离线部署](https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows)
- [Claude Linux 桌面端](https://code.claude.com/docs/en/desktop-linux)
