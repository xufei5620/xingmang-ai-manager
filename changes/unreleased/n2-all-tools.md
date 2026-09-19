## 用户

- 「检查」页的连接自检现在四个命令行工具各测一次，结果按工具分开显示：能用的说能用，
  配错了直接告诉你是网络、密钥、额度、分组还是模型的问题；还没配过的工具显示为
  「未配置」，不会当成故障吓人。
- Codex CLI、Gemini CLI、Grok CLI 的自检只核对账号下的可用模型，不会花掉账上的额度。

## 开发

- 功能 N2 扩展：`electron/connection-check.ts` 的分层归因从只支持 Claude Code 扩到四个
  provider。探测形态按工具收口在 `probeShape` 的穷尽 switch 里（无 default，加第五个 CLI
  是编译错）：Claude Code 保持原有的 `POST /v1/messages`（`max_tokens: 1`）不变，Codex /
  Grok / Gemini 走只读的 `GET …/models`，用各自配置文件里真正写着的 Key、base URL 与模型。
- 模型清单是按令牌分组过滤后的，所以「清单空」判分组层、「清单里没有这个模型」判模型层，
  无需为问出这两层去发一次计费的生成请求。失败侧（状态码 + 上游中英文关键词）四个工具共用
  同一张归因表。
- Gemini 的探测走 `/v1/models` 而不是它自己的 `/v1beta` 形态：本仓只实测过前者
  （`system-service.ts` 取模型清单用的就是它），令牌本身与协议无关，猜一个未实装的
  `/v1beta/models` 会把 404 误报成「服务上没有这个接口」（T12）。
- 新增 `unconfigured` 归因层，与 `config` 分开：没装没配不是故障，结果页显示为中性的
  「未配置」。`ConnectionCheckResult` 新增可选的 `evidence`，由主进程说明这次到底做了什么，
  渲染层不再照 provider 猜探测形态。
- `src/renderer-v2/pages-maintenance.tsx` 的连接自检卡片改为按工具分块（testId
  `health-connection-result-<provider>`），单个工具的 IPC 失败只影响它自己那一条；
  `connectionCheckView` 拆出 `statusLabel`，层名显示在工具名旁边不再塞进标题。
- 覆盖：`electron/connection-check.test.ts`（探测形态、清单归因、四工具共用失败表、Key 不
  外泄）、`src/renderer-v2/features/tools/connection-check.test.ts`、
  `src/renderer-v2/testing/app-check.mjs` 两条浏览器用例。
