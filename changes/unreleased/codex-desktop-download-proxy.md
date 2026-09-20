## 用户

- 开着加速安装或更新 Codex 桌面端时，清单查询和安装包下载现在会真正走加速线路，不再绕开加速直连。
- 切到镜像备用源时会一并说明国内镜像这次出了什么问题，不再只留一句「正在从镜像备用源下载」。

## 开发

- `electron/codex-desktop-service.ts` 的镜像清单探测与 MSIX 下载此前一直用主进程全局 `fetch`
  （Node 的 undici，不读系统代理），而加速只接管系统代理，于是 Codex 桌面端的下载无论加速
  开关都走直连。PR #231 已经把 Grok 二进制、Node.js LTS 与 npm 子进程接回系统代理，这次把
  同一条注入点补给 Codex 桌面端：`createCodexDesktopService` 新增必填的 `downloadFetch`，由
  `system-service.ts` 传入主进程的 `net.fetch`（Chromium 网络栈，读系统代理）。
- 为避免同类回归再次静默发生，`probeCodexDesktopManifests`、`fetchCodexDesktopMirrorRelease`、
  `fetchCodexDesktopPreviousManifestCandidates`、`downloadCodexDesktopPackage` 与
  `CodexDesktopCandidateDownloadOptions.fetchImplementation` 一并去掉了 `= fetch` 默认值，漏传
  变成编译错误。
- 安装前先调一次 `reloadDownloadProxyConfig`（接 `session.defaultSession.forceReloadProxyConfig`），
  免得刚打开加速就点更新时 Chromium 还拿着接管前的代理配置；刷新失败只记为不生效，不影响安装。
- 新增纯函数 `describeCodexDesktopPrimaryMirrorSkip`：主源清单查询失败时排序会把备用源提到第一
  位，之前界面上只有一句「正在从镜像备用源下载」，现在把探测阶段的失败原因带进下载提示。
