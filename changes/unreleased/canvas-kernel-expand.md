## 开发

- 画布换内核第一步（#1392，云端做的）：主进程先学会认 xingmang-canvas 内核写的工程和发的请求，这一版画布本身没有变化。
  工程校验器认六个新的节点字段（`dirty`、`imageCandidateCount`、`videoCandidateCount`、`outputText`、`promptReferences`、`textWebSearch`），
  设置里的数组放到 4096 项（蒙版笔迹），便签自己的 `settings.text` 当正文看、放到 10 万字且不再按链接或路径拦；提示词预设名放到 160 字。
  运行请求认内核新加的 18 个字段和 8 种内核才有的节点；桌面做不了的（一次出多张、联网搜索、蒙版、别的视频接口、
  这些新节点等）在发出任何付费请求之前整次拒绝，报中文原因，运行范围以外或已停用的不挡；Agent 发起的运行直接拒绝。
  引擎另有一道兜底，新节点绝不落到视频执行器。新增 `xingmangCanvasHost.capabilities()`（preload 里的固定字面量，不走 IPC，
  所有开关都是关），`createProject` 多收两个可选参数做「另存副本」（素材一起复制，只认本账号、未归档、有工作文件夹的源项目）。
  放宽经 yoyo 10-26 亲手同意（「画布放宽同意」）。契约样例在 `electron/fixtures/canvas-kernel-contract/`。
- 这一版是换内核以后的回退底线：退回到它，主进程能打开新内核存的工程，但这一版的画布读工程时会丢掉它不认识的东西，
  打开后一保存就再也找不回来。细节见 `docs/RELEASING.md` 第 8 节「画布换内核期间的退回」。
