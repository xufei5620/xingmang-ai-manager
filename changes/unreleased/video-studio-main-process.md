## 开发

- 视频剪辑第 1 期 PR2：主窗口新增出视频的通用通道（现在只有视频剪辑页在用）。`video:generate` 出一段视频、
  存进全局作品库，只回编号、缩略图、宽高和时长，途中的进度经 `video:progress` 推给发起的窗口；参考图可以是
  对话里选的图片。另有 `video:cancel`、`video:read-clip`（读字节给页面拼片）、`video:open`（用电脑默认的
  播放器打开，Windows 上经资源管理器转交）、`video:save-as`，以及剪辑页的 `video-studio:plan`（文字型号把一句
  想法拆成几个镜头，答得读不懂才再问一次）和 `video-studio:store-export`（拼好的成片存进作品库）。
  出视频的入参和画布共用一份解析（`parseVideoGenerateInput`），主窗口不收参考视频、参考音频。
  `chatService.cancelAll()` 现在也停没写完的 `completeOnce`，换账号、退出登录不用等它。
