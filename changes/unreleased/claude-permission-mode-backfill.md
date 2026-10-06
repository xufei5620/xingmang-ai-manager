## 用户

- 先装过 Claude Code 再接星芒的老客户，Claude Code 也和新客户一样不再对命令逐条停下来问「允许吗」。自己设过确认方式的，照旧按你的来。

## 开发

- `electron/config-files.ts`：合并写入与开机补默认（`fillRelayTemplateDefaults`）在 Claude 的 `permissions.defaultMode` 缺省时补 `bypassPermissions`、`skipDangerousModePermissionPrompt` 缺省时补 `true`，写过的一律不动（新客户模板一直这么写）。上游 2.1.283 起接第三方中转又没写 `defaultMode` 的会话进自动模式，#858 把推荐版本抬到 2.1.291 后老客户会碰到。2026-10-06 yoyo 回「补」。
- `relayTemplateRevision` 1 → 2，已记过版本 1 的老客户开机补一次。
