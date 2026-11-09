## 开发

- 0.2.24 深查 D66（手机遥控.md YKS-3、8、9、10、16、18、19、21）：手机遥控收到的几句，字照决定单一字不差，下面逐条。
- 启动慢（YKS-3）：`runPrompt` 只在收件队列里登记这一轮、发「收到」，起 Codex、开对话、交给 Codex 挪到队列外的
  `startTurn`，所以起 Codex 排安装队列那几分钟里「状态」「停止」照常有人理，「停止」靠原有的 `turnStillWanted`
  拦住还没交出去的那句；超过 15 秒还没交给 Codex，先回一句在准备。交给 Codex 的几步按渠道另排一条队（`handoff`），
  前一轮在回执路上被「停止」时，后一轮等它补完打断再交。
- 四种报错（YKS-8）：`codex-remote-text.ts` 的 `classifyRemoteTurnFailure` 按 Codex 的 `codexErrorInfo`（对过
  rust-v0.167.0 的 v2 `CodexErrorInfo`）和 `unexpected status NNN: <正文>` 里中转的原话（`relay-quota-failure.ts`）
  认出余额不够、登录失效、对话太长、连不上线路（网关类状态码用 `network-failure.ts` 的 `isServiceUnavailableResponse`）。
  单子四句之外的「密钥上限用完」用软件里已有的那句；认不出的照旧发原话。原话脱敏截短后记在
  `remote.turn-failed` / `remote.turn-start-failed` 的 `reason` 里。
- 旧消息（YKS-9）：超过 10 分钟或遥控打开以前发的照旧不执行，绑定的人收到「这条是 N 分钟前发的…」，1 分钟内送来的
  一批只回一句；陌生人照旧不回。原来钉住「不回」的那条测试改成钉住新行为。
- 改文件审批（YKS-10）：`readFileChange` 读 FileUpdateChange 的 kind 和 diff，每行写「新建 / 删除 / 改 / X 挪到 Y」，
  后面带「+N -M 行」（新建、删除数整份内容，改数统一 diff 里 @@ 之后的行）；老版本 Codex 不给 kind 时只列路径。
- 对话被重置（YKS-16）：关遥控、换文件夹、Codex 停了或出错丢掉对话时记一笔（`dropThread`），下次开新对话在「收到」
  前加一句；手机上发「新对话」、换了人不加。
- 解绑、换人、退出登录（YKS-18）：`tellUnbound` 在解绑前、新的人配对成功前、换凭据以前给原来那个人发一句，最多等 1.5 秒。
- 自动关（YKS-19）：闲 3 小时 50 分钟先提醒一次，回什么都重新起算，10 分钟后照旧关。
- 配对码（YKS-21）：快照加 `pairing.failures`、`pairingLocked` 两个可选字段，设置页手机遥控卡在配对那一行下面写
  「配对码错了 N 次」「这个码已经作废，请重新开始配对。」；手机那边照旧不回，计数规则不动。
