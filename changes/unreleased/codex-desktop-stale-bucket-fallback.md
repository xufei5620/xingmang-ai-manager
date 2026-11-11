## 开发

- `desktop-package-bucket.ts`：清单过期单独抛 `DesktopBucketIndexStaleError`（仍是 `DesktopBucketUnavailableError` 的子类，
  Mac、Claude、OpenCode 的调用处不变）；`readDesktopBucketPackage` 加 `allowStale` 选项。
- `codex-desktop-service.ts`：Windows 装 Codex 桌面端的顺序改成「新鲜的桶 → 商店 → 官网 → 过期的桶（比本机新才装）→ 第三方国内镜像」。
  第一路只因清单过期没用上时记下 `bucketStale`，商店、官网都没装上再回头用它；进度那句和国内镜像那一路同一句话。
  回头那一次桶太慢时比的是国内镜像（`measureCodexDesktopMirrorSpeed`），不再比已经失败的官网；交给 Windows 被拒时直接报错、
  不再换国内镜像（同官网那一路），日志里写「存储桶里的离线安装包也没装上」。官网的包下好、核过却被 Windows 拒装时照旧直接报错。
  起因：11-04 起 OpenAI 清单跑在包前面（同步按 #1404 记 package-pending、不刷 checkedAt），桶清单过期一天多，
  客户端整路跳过了桶。
