## 用户

- 「创作」左下角新增「作品库」：集中查看生成的图片和视频，可继续编辑、另存或添加到视频中。

## 开发

- 三块融合第 3 步（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9、新字 §2.2、§2.3、§2.7、§2.9）。主窗口有了自己的作品库：
  `features/create/CreateLibrary.tsx`（右边那一块、点开一件的小框、选择框 `LibraryPicker`）、`useCreateLibrary.ts`（分页读、再读第一页）、
  `library.ts`（纯函数：每件作品出自哪段对话、哪条视频，做出来的优先于只是用过的；哪些算成片；标题和小字怎么写）。`ChatPage` 多一个可选的
  `create.library`：只画左下角那一行和把右边让出来。
- 新增一条主窗口通道 `library:list`（`ipc-contract.ts`、`preload.ts`、`ipc/handlers/ai-library.ts`、`ipc-channel-policy.ts` 四处，CODEOWNERS 看得见）：
  只列当前账号图片和视频的编号、时间、名字、描述和各类的件数，不读文件、不回路径、不列回收站里的。入参逐项校验（`ipc/parsers/ai-library.ts`：
  一页 1 到 60 条、搜索最多 128 字、成片编号最多 200 个、页面搜到的编号最多 2000 个，编号只认作品库那一种样子）。看图和页面里放视频走
  `xingmang-asset:` 协议，另存、用播放器打开用对话和视频已有的通道，每一条都在主进程按当前账号再认一次。没有新增 `canvas-host:*` 通道，
  `canvas-v2/` 没动，素材的元数据格式没加字段。
- 页面里放视频用的还是第 2 步那条 CSP `media-src xingmang-asset:`（yoyo 2026-11-09「看片放开」），没有再放宽。
- 聊天顶栏的「看做过的图」（2026-11-11 Q4，开画布窗口的素材库）撤了，`ChatPage` 的 `onOpenAssets` 和 `chat-assets-open` 一起撤；顶部搜索多一条
  「作品库」（`action:create-library`）。主进程的 `canvas:open-asset-library` 通道这次没删，页面已经不调它，留给后面清理。
  `canvas-reload-forget-project.md` 里给客户看的那一句说的就是这颗按钮，按钮没了，那一句撤掉（开发那一段照留）。
- 视频工作台：镜头上多「从作品库选图」「使用已有片段」；镜头多一个可选字段 `borrowed`（用的是作品库里现成的一段：不用生成，没有「生成」和
  「时长」，总时长按片段自己的长度算，`videoStudioShotLength`）。第 2 步的 `appendVideoStudioClip` 接进来的那一段现在也记 `borrowed`，
  所以「添加到视频」加的镜头显示成「已有片段」（第 2 步还没发版，客户没见过原来的样子）。起始页第三张卡「用已有片段合成视频」走
  `createVideoStudioProjectFromClips`。老工程没有这个字段，照旧读。
- 这一步客户看得见的字按 2026-11-21 定的正式口吻写，跟方案原话的逐字对照在 PR 正文和 `0.2.25-方案/三块融合/第3步-新加的字.md`。
- 没做的：出图框合一（第 4 步）、「放进画布」（第 5 步，等 yoyo 亲手打同意句）；作品库里删除、改名、打标签（画布窗口的素材库里照旧能做）。
