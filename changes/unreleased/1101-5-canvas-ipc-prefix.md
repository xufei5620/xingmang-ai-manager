## 开发

- 画布宿主桥剥掉 IPC 报错前缀（#1101 第 5 条）：`electron/canvas-preload.ts` 的每个 invoke 都走一个本地 `invoke` 包装，拒绝时把 Electron 包上的「Error invoking remote method '通道': 类名:」逐层剥净再交给画布，规则与 renderer-v2 的 `rawErrorMessage` 一致（sandbox preload 不能 import，照 I7 复制一份）。画布 `canvas-v2/` 里约 30 处 `setBanner(error.message)` 和节点上的错误一字没改，原样显示的就是主进程的中文原话；自动保存那份自己剥前缀的正则对已剥净的报错是空操作。#1101 的其余几条（对话剥前缀、上游 400/404 分类、Enter 键、生图尺寸误判、自动保存分开权限和磁盘满）不在这里。
