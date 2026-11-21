## 用户

- 「创作」的输入框新增「生成视频」，一句描述即可生成一段，并可添加到视频中。

## 开发

- 三块融合第 2 步（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9、新字 §2.4 到 §2.6）。`ChatPage` 的模式多一档
  `video`，只在「创作」页把 `create.video`（`ChatPageVideo`：能不能用、价目、余额、左边那一列里的视频、怎么接到一条视频上）交下来时出现；
  历史账号、出视频临时停用时这一档灰着。规矩在 `features/chat/video.ts` 和 `state.ts` 的 `planTurn`（只带 1 张开头图、不带文件、
  描述最多 1500 字），交单、接回、停止在 `useChatController.ts`，界面在 `ChatVideo.tsx`。
- 没加 IPC 通道：用视频工作台那几条（`video:generate` / `video:resume` / `video:cancel` / `video:open` / `video:save` 和进度事件）。
  扣费上的规矩照视频工作台：请求号先写进这条回复、存了盘再交；页面打开时没等到的每一单拿请求号接回，不再交一单；已经交给服务端的
  停不下来就说清钱已经扣了、接着等；提交结果不明的重新生成沿用原请求号并先提醒可能多扣；同时最多 3 段。
- 主窗口 CSP 加一条 `media-src xingmang-asset:`（`electron/app-protocol.ts` 和 `index.html` 一字不差，测试钉住；yoyo 2026-11-09
  亲手回「看片放开」，范围只到作品库里当前账号的音视频）：对话里出好的一段视频点了在页面里放 `xingmang-asset://video/<编号>`，
  主进程照旧按账号认过才给字节。没有 `'self'`、`blob:`、`data:`、远程地址。
- 「添加到视频」：`video-studio/project.ts` 的 `appendVideoStudioClip` / `createVideoStudioProjectFromClip` 把一段视频接成某条视频的
  最后一个镜头或新开一条；`useVideoStudioLibrary` 多 `replace` / `revision`，从工作台外面换掉一条视频时版本号加一，开着的工作台按新的
  重新挂，旧的那份 `source` 之后再写不收。`video-studio/clip.ts` 把「存着的一段视频怎么读回来」从 `project.ts` 拆出来，对话的存盘层也用它。
- 对话记录里视频只存编号、宽高、时长和没等到那一单的请求号（`storage.ts`，读回来逐项校验）；导出的文件和搬到新电脑的对话不带视频，
  各留一句说明；导入的对话里带 `video`、`requestId` 的一律不收。
- 这一步客户看得见的字按 2026-11-21 定的正式口吻写（方案 §2.4 到 §2.6 里那几句也照它重写了，逐字的对照在 PR 正文和
  `0.2.25-方案/三块融合/第2步-新加的字.md`）；跟视频工作台同一句话的几处用的是正式化清单里给那句定好的写法。
- 没做的：主窗口作品库（第 3 步）、出图框合一（第 4 步）、「放进画布」（第 5 步，等 yoyo 亲手打同意句）。`canvas-v2/` 没动。
