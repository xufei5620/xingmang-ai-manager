## 开发

- 首页「打开」先进设置页刚换的项目文件夹（0.2.25 总单 Q1）：设置页「更换」经 `settings:save` 带 `workspaceChosen`，
  主进程按自己的时钟记成 `AppSettings.workspaceChosenAt`（渲染层给不出时间）；`workspace` 被首页「选择其他文件夹…」、
  新建项目文件夹换成另一个文件夹时去掉。`config:get` 与 `cli:launch` 的结果多带 `rememberedWorkspaceChosenAt`，
  `launchWorkspaces` 在它比这个工具最近一条对话还新时把设置页换的文件夹排到最前面，之后又在别处用过以那次为准。
  首页卡片、引导最后一步、托盘和快捷键打开都走这一条；设置页换完重读一次配置，首页马上换。没有新通道，没有新字。
