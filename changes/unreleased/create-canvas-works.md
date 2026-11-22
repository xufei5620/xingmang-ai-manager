## 开发

- 三块融合第 5 步里不涉及放宽的两件（yoyo 2026-11-22 回「画布续做」，方案 `0.2.25-方案/三块融合/方案.md` §9、§2.8、§6）：
  画布项目里生成的图片和视频列进主窗口的作品库；「创作」页点一个画布项目，卡上多一张封面，下面多一块「此项目中的作品」。
  「放进画布」没做（等 yoyo 亲手打同意句），画布窗口和 `canvas-v2/` 一行没动。
- 没有新增通道。两条原有的主窗口通道各多一个可选字段：`library:list` 入参多 `canvasProjectId`（只看这一个项目做的，
  `ipc/parsers/ai-library.ts` 只认项目编号那一种样子），每条作品多 `canvas: { projectId, projectName, used? }`；
  `canvas:list-projects` 每个项目多 `cover: { assetId, mediaType }`（只交出作品编号，图由 `xingmang-asset:` 按当前账号认过才给）。
  画布能调的 `canvas-host:*` 没变，素材的元数据格式没加字段。
- 主进程：`canvas-project-asset-manager.ts` 多 `listLibrary`（当前账号的 AI 作品文件夹，加上每个没归档的画布项目工作文件夹里
  `source` 不是 `imported` 的图片和视频；没绑文件夹的项目，节点上挂的那些在 AI 作品文件夹里本来就列着，只标上是哪个项目的，
  不是画布生成的标 `used`；已归档的、文件夹这会儿连不上的不列；同一个编号只列一次）和 `holderOf`（一件作品放在哪个仓库）。
  项目清单和每个文件夹各留 5 秒，画布经这个管理器存进新东西时那个文件夹的那一份当场作废。项目名由 `canvas-project-store.ts` 的
  `displayCanvasProjectName` 洗成一行、最长 128 字才出主进程；`listLibrarySources` 只读没归档的项目、最多读到在用项目数的上限。
  `ai-media-asset-service.ts` 把分页那一段拆成纯函数 `pageAiMediaLibraryRows`，搜索多认一个画布项目名。
- 主窗口读文件的那几条（`chat:copy-asset`、`chat:save-asset`、`chat:asset-menu`、`video:read-clip`、`video:open`、`video:save-as`，
  以及对话里带图、「基于此图继续编辑」读回原图）在 AI 作品文件夹里找不到时，经 `holderOf` 到当前账号的画布项目文件夹里找，
  读的时候过的还是那个仓库自己的检查（只认当前账号的、按文件头认类型、大小上限、不跟链接，I8）。主窗口只读不写：
  新做出来的东西还是只存进 AI 作品文件夹（`video-studio:store-export` 没改）。
- 页面里放视频用的还是 `media-src xingmang-asset:` 那一条，CSP 没改。作品库里现在多了画布项目里生成的视频，所以页面里能直接放的
  也多了这一部分（仍只是当前账号自己的）；这一点在 PR 的安全说明和发给 yoyo 的字里写明了。
- 界面（`features/create/`）：`library.ts` 的出处多一种 `canvas`（对话、视频做出来的优先，其次画布做出来的，再其次只是用过的），
  `CreateLibrary.tsx` 多 `CanvasProjectWorks`（项目下面那一块，用同一个 `useCreateLibrary`，多传一个项目编号）和点开一件时的
  「查看画布项目」；`CreatePage.tsx` 的项目卡多封面（`CanvasProjectCover`，没有封面或读不出来时还是图标）。
  「查看画布项目」只在「创作」页里把右边换成那个项目，不开画布窗口；项目已经不在清单里时提示一句并重读清单。
  方案里项目下面最后一格「在作品库里看全部」没照做：作品库没有按项目筛选的那一档，换成在原地「加载更多」。
- 新字和改的那一句（作品库最下面的灰字）按 2026-11-21 的正式口吻写，逐字对照在 PR 正文和
  `0.2.25-方案/三块融合/第5步-新加的字.md`，确认词「画布作品字改」。
