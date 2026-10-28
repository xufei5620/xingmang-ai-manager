## 用户

- Claude 桌面端里能换型号了：在星芒里给 Claude 桌面端重新保存一次配置，它的型号菜单里除了你选的那个，
  还会列出当前账号别的能用的 Claude 型号（最多 8 个），以前只有选中的一个、换不了。

## 开发

- Claude Desktop 的型号菜单就是配置里的 `inferenceModels`：3.6556.2 安装包里网关的 `adminListObviatesDiscovery`
  在清单写满完整型号名时跳过 `/v1/models`，菜单只有清单上的几个，第一个是默认；#746 起只写选中的一个，客户就换不了。
- 新的 `electron/claude-desktop-models.ts`：保存时选中的排第一，其余是这把密钥列着的 `claude-*`（`sortClaudeModelsNewestFirst`
  按版本新到旧，连同选中的最多 8 个），每个照 Claude Desktop 的启动检查发一个字（`POST /v1/messages`，`max_tokens: 1`，
  8 秒超时，最多同时 3 个），通了才写，没通的进运行日志 `external-client.claude-desktop.models`。中途换了账号就什么都不写。
- 多个型号写成 `{ "name": ... }`（3.6556.2 两种写法都认），开机的 `claude-desktop-model-repair.ts` 只认 0.2.12 的字符串写法，
  不会把新清单改回一个；只有一个时照旧写字符串。
- 0.2.12（#685）不加核对地写全部 `claude-*` 出过「型号被拒、发消息没回复」：Claude Desktop 启动检查和起标题这类后台小活
  先挑 Haiku（`claudeDesktopStartupCheckModel` 照它 `probeInference` 的挑法：haiku → sonnet → opus，同档挑名字最短的，微调排后），
  中转列着的不一定发得通（推测）。所以连接自检在默认型号之外，再用启动检查挑的那个问一次，不通就报那个。
- 已经配好的老配置不自动加，要客户在星芒里重新保存一次。
