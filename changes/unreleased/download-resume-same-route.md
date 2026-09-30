## 用户

- 装 Codex 桌面端、Node.js、Git、Python 时，下载到一半网断了一下（Wi-Fi 抖动、切热点、电脑睡了又醒），不再换一条线路从头下：先在同一条线路上从断开的地方接着下，进度条接着走，界面会写「网络断了一下，正在从国内镜像接着下载」。接不上才换下一条线路，和以前一样。

## 开发

- 第二十一批 5。新增 `electron/download-retry.ts` 的 `downloadWithResume`：已经收到数据后连接断开、读流报错、45 秒没有新数据或连接提前结束时，隔 3 秒 / 10 秒带 `Range: bytes=N-`（有强 ETag 用 ETag，否则 Last-Modified 作 `If-Range`）在同一地址续传；只接受 206 且 `Content-Range` 恰为剩余区间、总长与首个响应一致，否则把原来的失败原样交回调用方去换线路。一个字节都没收到的失败不重试，用户取消与整体超时不重试；同一次下载最多续 6 次，连续两次毫无进展就放弃。
- 摘要只累加已写入文件的字节，续传前把文件截回已写长度，所以不需要重读已下部分；四处调用方原有的首响应检查、大小上限、重定向白名单与最终 SHA-256 核对一条没放宽。
- `codex-desktop-service.ts` 的 `downloadCodexDesktopPackage`、`node-runtime.ts` 的 `downloadMsi`、`git-runtime-install.ts` 与 `python-runtime.ts` 的 `downloadInstaller` 改用它。Node / Git / Python 以前只有 10 分钟总超时，现在多了 45 秒首包与 45 秒无数据超时（续传要靠它发现「卡住不动」）。三处安装依赖新增可选测试接缝 `waitBeforeResume`，`CodexDesktopDownloadProgress` 新增可选 `resuming`。
- 沙箱里只核到 nodejs.org 支持 Range（206 + 强 ETag）；Codex 国内镜像、镜像备用源、npmmirror、python.org 被沙箱代理拦了，没核，是否支持续传靠运行时探：不支持就退回原来的换线路。
