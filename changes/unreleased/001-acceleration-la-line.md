## 用户

- 网络加速换了新线路：原来的加速线路已经连不上，现在换成星芒自己的一条美国线路，专门用来打开 ChatGPT、Codex 这些 OpenAI 的服务，「游戏加速」也改名叫「网络加速」。开着加速时别的网站不走这条线路，照常直接连；装工具、下载 Node.js 时也不再借用加速线路。
- Mac 上开着别的 VPN 时，点「开启加速」会先提示「检测到其他代理或 VPN 正在运行」，不用等到连接失败才知道。

## 开发

- 内置线路换成自建的洛杉矶 Hysteria 2（`bundled-acceleration/profile.yaml` 一条，重算 `profile.sha256`，#1352）：
  节点商把原来 12 条迁到新域名后大多已失效。服务器只放行 ChatGPT / OpenAI 相关域名，所以
  `acceleration-clash-config.ts` 的规则从「其余全走线路」（`MATCH,XINGMANG`）改成只把 `lineRoutedRules`
  （chatgpt.com、openai.com、oaistatic.com、oaiusercontent.com 及子域名，challenges.cloudflare.com，
  选线测速用的 www.gstatic.com）送去线路，兜底 `MATCH,DIRECT`；网络位置探测的 www.cloudflare.com 不送，
  安装源顺序按直连时的位置排。
- `main.ts` 不再给系统服务和扩展服务传 `acquireDownloadAcceleration`：装 CLI、下 Node、GitHub 下插件目录都不借线路，
  用户自己开着加速时下载在内核里按规则直连，也不再算「已加速」把安装源切成官方优先。`download-acceleration.ts`
  和 `startDownloadRoute` 留着，以后有能下载的线路再接回去。
- `acceleration-conflict.ts`：Mac 上连接前对线路服务器的 IP 跑一次 `/sbin/route -n get`，出口是 utun / ppp / ipsec
  就报已有的 `virtual-adapter` 冲突（沿用现有提示和「仍然连接」）。只读路由，不改用户的 VPN 和路由表，主机名不问（不替它解析）。
  2026-10-21 yoyo 的 Mac 开着 VPN 时 QUIC 在 VPN 那条路上超时，同一进程单独走 Wi-Fi 能连。
- 界面「游戏加速」改叫「网络加速」（侧栏/搜索/设置项、卡片标题、使用说明、教程、状态栏悬停、断开通知、换账号报错），
  卡片说明、使用说明、教程里说游戏和下载借线路的句子换成只说 ChatGPT、Codex（yoyo 10-22 回「改为网络加速就行」「改」）。
