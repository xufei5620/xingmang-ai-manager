# 桌面聊天

`ChatPage({ bridge: XingmangApi, accountScope: string, active?: boolean, openParameters?: boolean, onParametersOpened?: () => void })` 照 v4 原型：236px 会话栏（搜索常驻、按今天 / 昨天 / 更早分组）、顶部当前会话、独立滚动消息区和底部输入框（模式、模型菜单、画图选项、加图片、发送都在框里）。父级应提供无额外 padding 的内容空间。`openParameters` 是顶部搜索「聊天参数设置」交下来的：为 true 时打开参数对话框，打开后调 `onParametersOpened` 放下。

同一账号内保留组件挂载并以 `active={false}` 暂时隐藏：后台请求、会话与草稿继续保留，隐藏时不处理输入快捷键且移除顶层弹窗和菜单。账号改变仍按 scope 重建并取消旧请求。

所有 IPC 都封装在 `api.ts`。该文件只复用 `electron/ai-chat-protocol` 已验证且无 Node 依赖的模型能力与请求校验函数，不修改协议，不依赖旧渲染层。

已实现：

- 模型菜单不选分组（2026-10-25 产品负责人定）：打开聊天时把账号每个能用的分组都准备一遍（一次最多三个，还没有对话密钥的分组这时签一把「用户名-分组-对话」，之后复用），各分组的模型并成一张表、按厂商分节（`chatModelVendors`），同一个模型只列一次，小字写选它以后按哪个分组计费。几个分组都有同一个模型时按 `pickChatGroup` 挑：这段对话正在用的分组 → 出图挑图片分组、聊天挑推荐分组 → 价格倍率低的 → 后台列的先后。
- 记着的模型由 `settleChatModel` 落定：正在用的分组还没读完先不动；模型还在就挑一个有它的分组；哪儿都没有了，等各分组都读完再换成默认模型。后台刷新（切回窗口、打开菜单）只重读分组列表，已经读过的分组不再准备，新冒出来的分组读一次；这时模型哪儿都没有了不悄悄换，输入框上面说「当前模型已不可用」等用户自己换。原来的分组没了、别的分组有这个模型，换过去并说一句计费分组换了。菜单底部「刷新模型」把分组和每个分组的模型都重读一遍。按主进程规则过滤隐藏和不可用模型，保留图片尺寸、画质、分辨率以及自定义尺寸。
- 文本、思考与 Markdown 输出；停止、复制、编辑重发、重新生成、删除消息、清空及删除会话。
- 每个会话独立保存参数、系统提示词、草稿、模型和分组。参数在 `ParametersDialog.tsx` 的对话框里改，点「应用」才写回这段对话；四个滑块没动过就是「默认」，请求里不带这一项。重试使用原请求快照，不重复添加用户消息；编辑重发移除依赖旧消息的后续内容。
- 图片真实生成、预览、复制、另存和主进程原生菜单。另存取消不会提示成功。
- 对话里的图片格子和输入框上的待发小图放主进程缩到 768 的那张（`ChatImage.tsx`，`xingmang-asset://thumb/v2/image-large/…`），点开大图才读原图；缩略图出不来退回原图。WebP 和原图不比 768 大的直接用原图。都按需加载（`loading="lazy"`），记过宽高的先占位（总单 78 R-2）。
- 自定义尺寸填得不合型号规矩（宽高要是倍数、在上下限之间，`customImageSizeRule`）时不发，尺寸框下面说清规矩（跟画布同一句，`describeImageSizePolicy`）；离开尺寸框或点发送才露出来，改对就收起。主进程生图服务在解析密钥、发请求之前按同一张型号表再核一次。
- 生成图片可以带 1–4 张参考图照着改（模型要能改图，`canEditImages`，现在是 gpt-image 和 Grok 图片那几个）：加图片、粘贴截图都行，对话里生成的图点「拿这张接着改」放进输入框。参考图只以主进程存的图片编号随 `chat:generate-image` 的 `sourceAssetIds` 发出去，主进程换成 Images API 的 edits，按账号读图（`readOwned`）。重新生成照原来那几张再改一次。
- 生成图片的型号、分组、尺寸、画质、分辨率按账号记一份（`image-settings.ts`，融合第 4 步），不再每段对话各记各的：视频工作台「AI 生成图片」的出图框（`../video-studio/ShotImageDialog.tsx`）记的也是它，两边用同一排选项（`ImageOptions.tsx`）。客户动了这几样就往那一份里写（手填到一半、还不合型号规矩的尺寸不记）；切到「生成图片」、打开一段对话、新开对话、模型表读完、别处改了这一份时，开着的这一段照它对一遍（`useChatController` 的 `syncImageSettings`，正在生成时不动；记的型号这会儿不在模型表里就留着自己的型号，别的照样跟）。只是照着对一遍不算改过对话，不动 `updatedAt`、不重排左边那一列。对话记录里每段对话原来那几个字段照旧存，格式没动。
- 图片取消前确认费用风险，取消回执为 `mayStillComplete` 时继续显示可能计费的说明，再次生成需要明确确认。
- 账号 scope 切换重建控制器、取消旧请求并拒绝旧事件和图片回包；单会话同时一个请求，窗口内最多四个并行请求。
- Enter / Shift+Enter 与中文输入法组合阶段隔离，剪贴板失败可手动复制。
- 输入框第三档「生成视频」（融合第 2 步，方案 `0.2.25-方案/三块融合/方案.md` §2.4 到 §2.6）。只有「创作」页把 `create.video`（`ChatPageVideo`：能不能用、价目、余额、左边那一列里的视频、「添加到视频」怎么接）交下来时才有这一档；单独挂 `ChatPage` 时没有。没加 IPC 通道，用的是视频工作台那几条（`generateAiVideo` / `resumeAiVideo` / `cancelAiVideo` / `onAiVideoProgress` / `openAiVideo` / `saveAiVideo`，封在 `api.ts` 的 `video`）。
  - 规矩都在 `video.ts`（纯函数）和 `state.ts` 的 `planTurn`：只带 1 张开头图、不带文件、描述最多 1500 字；交给主进程的那一单由视频工作台的 `buildVideoClipRequest` 拼（比例、秒数、从哪张图开始）。每次发送前先问价（`ChatPage` 的确认框，价目和余额是「创作」页给的；切到这一档、打开确认框时各叫它重读一次价目）。
  - 扣费上的规矩照视频工作台（`video-studio/useVideoStudio.ts`）：**请求号先存再交**（`submitVideo` 先 `saveNow()` 把带着 `video.requestId` 的那条回复写进文件，再调 `generate`），交完就断电也拿得回这一段；页面打开时 `pendingChatVideos` 里的每一单拿请求号回主进程接（`resumeAiVideo`），不会再交一单。
  - 「停止」：主进程回「还没交出去」的照「已停止」，不花钱、不留请求号；回「可能还会完成」的说 `chatVideoBilledNotice`，接着拿请求号等。提交结果不明的（`unconfirmed`）重新生成时沿用原请求号并先说清可能多扣一次；没等到结果就失败的先拿请求号接回，主进程确实没有这一单才重新交（`chatVideoRetry`）。
  - 一段对话同时只有一条在等的回复；几段对话加起来最多 3 段视频（`maxParallelChatVideos`，同视频工作台）。
  - 等着的那一块和出好的那一段在 `ChatVideo.tsx`。出好的点了才放：`<video>` 的地址是 `xingmang-asset://video/<编号>`（`video-studio/clip.ts` 的 `videoClipPlayUrl`），主进程按当前账号认过才给字节。主窗口的 CSP 只为这个加了一条 `media-src xingmang-asset:`（见 `electron/app-protocol.ts`，产品负责人 2026-11-09「看片放开」，不许再扩大）。读不到就照「文件不在了」说。
  - 「添加到视频」把这一段和它那句描述交给「创作」页（`create.video.addClip`），接成左边某条视频的最后一个镜头；「用此图生成视频」把一张出好的图挂成开头图、切到这一档，不自动发。
  - 记录里只存片段的编号、宽高、时长（缩略图地址每次按编号现拼）和没等到那一单的请求号；导出的文件、搬到新电脑的对话都不带视频，各留一句说明。
- 左下角「作品库」（融合第 3 步）。原来顶栏那颗「看做过的图」（开画布窗口的素材库，`onOpenAssets`）撤了，换成「创作」页经 `create.library`（`ChatPageLibrary`）交下来的这一行：这一页只画左边一列最下面那一行（名字、件数）和把右边让出来，作品库那一块、选择框都由「创作」页给（`features/create/CreateLibrary.tsx`）。右边摆着作品库时对话那一块只藏不卸，跟点开一条视频一样。作品库要用对话这边的三件事由 `library.render` 的 `context` 交出去：回到某段对话（`openConversation`）、把一张图放进输入框接着改（`reuseImage`）、把一张图当开头图切到「生成视频」（`animateImage`）；后两件遇上当前对话正在生成（输入框锁着）就放进一段新对话。对话从「正在生成」变回来时调一次 `library.refresh`，左下角的件数跟着变。

记录经主进程存到用户数据目录的 `chat-history/` 下（`electron/ai-chat-history-store.ts`），一个对话一个文件加一份索引，每次只重写改过的对话，不再受 localStorage 的 4 MB 限制；页面先读到记录再显示（读的时候摆跟按需加载同一块「正在加载页面...」），避免空白状态抢先覆盖。旧版本留在 localStorage 的 `xingmang-ui-v2:chat:<scope>` 只读不写，新存储还没有这个账号的记录时读它，首次保存即完成迁移。记录不包含运行时素材 URL 和请求 ID。写盘前还会剥掉正文、思考、错误、标题、草稿、系统提示词和图片提示词里的凭据（`sk-`、`Bearer`、`api_key=`/`token=` 这类键值）与运行时专用负载（`blob:`、内联 `data:` base64），窗口里的内容不受影响；普通链接和正文照原样保存，本地记录对真实内容仍然无损。自动保存等改动停下 250 毫秒再存，回复一直在出字时从头一处没存的改动算起最多等 2 秒；退出前主进程还会先问一声（`electron/chat-history-flush.ts`），开着的聊天页把手上的马上存一次、写完再退。读取时只重建合法的本机素材协议地址，未完成消息降为已停止，已经出来的那部分字留着。索引本身读不出来时整份保留原始值，并持续说明当前会话不能保存，避免悄悄覆盖损坏数据；点「重新读取」还是读不出来时再提示一次。只有某一段对话的文件读不出来时只跳过那一段，其余照常读写，下一次保存由主进程把那个文件改名挪进同目录的 `unreadable/` 原样留着（不删），页面上说一句「有 N 段对话无法读取，已单独保留，其余对话不受影响。」；文件已经不见了的只从索引里拿掉（0.2.24 深查聊天页 C2）。读不出来的原因只写进本机运行日志，上屏一律是「历史聊天记录暂时无法读取，原文件未作修改」，超过对话上限另说一句。

若完整 scope 以 `:<userId>`、`/<userId>` 结尾或本身等于 userId，且旧记录 owner 与当前已验证账号一致，会无损导入旧 `xingmang-ai-chat:v1:<userId>` 记录；旧 key 保留。

验证：

```powershell
npx vitest run src/renderer-v2/features/chat/state.test.ts --no-file-parallelism --testTimeout=30000
node --test src/renderer-v2/features/chat/browser-check.mjs
```

浏览器测试只访问本地 fixture，所有非回环网络请求被拦截。暗/亮 × Win/Mac × 默认/空/失败截图及图片结果截图位于 `.project-surgeon/audits/20260907-chat-v2/`。这是浏览器平台展示矩阵，不替代 macOS 原生验收。
