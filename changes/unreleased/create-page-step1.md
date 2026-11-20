## 用户

- 聊天、无限画布、视频剪辑合成了「创作」一页：做过的对话、视频、画布项目都排在左边一列，视频不再限 20 条草稿。

## 开发

- 三块融合第 1 步（yoyo 2026-11-20 回「融合改」，方案 `0.2.25-方案/三块融合/方案.md` §9）。侧栏 `chat` 改叫「创作」，`canvas`、`video`
  成了它的别名（`registry/pages.ts` 的 `createPageAliases`）：不出侧栏、不单独出搜索结果，`navigate('canvas')` 照旧开画布窗口，
  `navigate('video')` 落到「创作」并接着最近那条视频。新增 `features/create/`：`list.ts`（三类混排、筛选、时间写法，纯函数）、
  `CreatePage.tsx`（视频、画布项目那一半和起始页的卡；对话那一半仍是 `ChatPage`，经 `create` 这个可选属性把多出来的行和右边的面板交给它）。
- 视频草稿改成一条一个文件（0.2.25 总单 #79）：主进程 `electron/video-studio-project-store.ts` 按账号存在用户数据目录下
  （原子写、reparse 与单链接检查、每条和总数上限），渲染层 `video-studio/library.ts`（纯函数：文件内容、老草稿怎么抄、抄完怎么核对）
  和 `useVideoStudioLibrary.ts`（写盘攒 400 毫秒一批，发请求前和退出前立刻写）。0.2.24 留在 localStorage 里的两格只读不删，
  头一次打开各抄一份，读回来镜头数、已生成段数、片名、想法都对上才写「抄过了」的记号；退回 0.2.24 老草稿原样在。
  `VideoStudioPage` 只剩一条视频的工作台，页头、「新建一条」「重新开始」、草稿箱撤了，对应的 `video-new`、`video-reset`、
  `video-drafts`、`video-draft-*` 四类 testid 和草稿箱用例一起撤，换成列表侧的用例。
- 新增四条主窗口通道（`ipc-contract.ts`，CODEOWNERS 看得见）：`canvas:list-projects`（只回编号、名字、时间，项目内容不出主进程）、
  `canvas:open-project`（编号先按格式校验，再在当前账号没归档的项目里认过才用；开画布窗口并直接进这个项目）、`video-studio:read-projects`、
  `video-studio:write-projects`。没有新增 `canvas-host:*` 通道，`canvas-v2/` 没动。
- 「新建」不再先往列表里加一条空的「新对话」（`useChatController` 的 `newConversation`）：回到不进列表的那段空白对话，发了第一句才列出来；
  空白页的模型和设置跟着刚才那段对话走，打了字没发的照旧先存成一段对话。存满 200 段时改在发第一句时提示。起始页从头看起，不再停在最底下。
- 没做的：出视频并进输入框（第 2 步）、主窗口作品库（第 3 步）、出图框合一（第 4 步）、画布互通和「放进画布」（第 5 步，等 yoyo 亲手打同意句）。
