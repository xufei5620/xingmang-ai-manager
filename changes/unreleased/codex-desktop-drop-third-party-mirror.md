## 开发

- Codex 桌面端拿掉第三方「国内镜像」`codexapp.agentsmirror.com` / `codexapp-r2.agentsmirror.com`（yoyo 2026-11-24「全拿掉」）。
  那是开源项目 Codex App Manager 作者的私人镜像，不归星芒，作者找上门说被下了 270 次。删了镜像的清单探测、
  下载、`previous/*` 上一版兜底、测速和对象存储签名跳转白名单；`validateCodexDesktopResourceUrl` 现在只许跳回
  同一主机同一路径、不带查询参数。Windows 安装顺序变成存储桶 → 微软商店 → OpenAI 官网 → 清单过期的存储桶。
- Windows 首页「可更新」改看星芒存储桶 `chatgpt/latest.json` 里那一版（清单过期也照读），跟 Mac 10-27 起的做法一致；
  `latest` 取官网清单和桶里新的那一版（`buildCodexDesktopManifestBundle`）。`DesktopAppStatus` 的
  `mirrorVersion` / `mirrorUpdateAvailable` / `mirrorError` 字段名不变，意思换成国内下载线路（存储桶）。
- 官网那一路只在后面还有过期的存储桶可退时才因为「还要 10 分钟以上」放弃（`abandonWhenSlow`）；后面没有路时多慢都下完。
  回头用过期清单的那一次存储桶不再拿镜像测速，下得慢也不放弃。
- 都没装上时交出存储桶那一路的原话，失败归类认了存储桶的几种说法（大小或 SHA-256 和清单不一致、没下完、清单里没有
  这台电脑能用的包）；「已是最新」那条判断抽成 `resolveCodexDesktopUnchangedOutcome`，客户看到的字没变。
- 文档：`docs/RELEASING.md`「Codex Desktop 下载来源（Windows）」重写，AGENTS.md 第 7 节那条「不要动 Codex 桌面端的
  镜像实现」换成「不要加第三方下载源、不要放宽跳转校验」，`docs/IMPROVEMENT-PLAN.md` 2.6 补更正。
