## 用户

- Codex 以前的设置里有一处它自己认不出、看着连好了一打开却报 Key 无效的老用户：现在登录或打开软件时会自动改好，不用再点「修好它」，改完会提示一句，原来的设置在「备份」里能找回。

## 开发

- 第十七批 1b：`accountBootstrapPlan` 对「Codex 保留名 + 没有归属记录 + Key 正是当前账号缓存里那把」（`configurationOwnership === 'unknown'` 且 `configurationAccountMatched` 且 `codexProviderShadowed`）放行自动重写，记进 `shadowRepairs`；结果带 `repairedShadowed`，首页 toast 一句、运行日志一行。
- 主进程 `saveConfig` 的「来源未经确认就不自动改写」闸新增唯一放行 `permitsShadowedCodexRepair`：只认 Codex、`unknown`、shadowed、地址是当前站、配置里的 Key 与这次写入的当前账号 Key 相同；`changed` / `manual` / Key 不同一律照旧拒绝、只给按钮。写入走现成的两阶段写入与备份，写完登记为账号来源。
