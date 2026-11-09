## 开发

- 画布宿主桥加两条通道，给 xingmang-canvas 新内核的「新建项目默认放进「文档 › 星芒画布」」用（画布完善第 3 条）：
  `canvas-host:create-project-in-default-folder` 只收项目名，主进程在 `app.getPath('documents')/星芒画布/` 下按名字新建一个空文件夹
  （去掉文件名里不许出现的字符，同名的已经在了就加「 (2)」，已经在的文件夹一律不用，`canvas-default-project-folder.ts`），
  不弹选文件夹的框；`canvas-host:relink-project-folder` 只收项目标识，只对工作文件夹已经找不到的项目弹系统对话框让客户重新选
  （`CanvasProjectStore.relinkWorkspace`，用素材的项目要选带 assets 的文件夹）。画布给不了路径，复制项目照旧先选空文件夹。
  客户看得到的变化随内核 kernel-v0.1.4 同步一起写在 `canvas-kernel-v0.1.4.md`。
