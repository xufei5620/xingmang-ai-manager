## 用户

- 新装或更新 Claude Code 时装的版本从 2.1.277 抬到 2.1.278。

## 开发

- `electron/cli-verified-versions.ts` 的 `claude.recommended` 抬到 `2.1.278`（npm latest，
  2026-09-19 发布），`verifiedAt` 记 2026-09-21。依据只有上游 changelog：2.1.278 一共两条，
  「auto mode 在 Claude API / Enterprise / Bedrock / Vertex / Foundry / gateway 上默认改走服务端
  分类器」与「`/status` 加一行 `Auto mode server`」，没有针对第三方 `ANTHROPIC_BASE_URL` 的回归，
  也不落在名单现有的两条 `blocked` 区间里。`verifiedSites` 仍为空数组：**没有在中转上跑过真实请求**。
