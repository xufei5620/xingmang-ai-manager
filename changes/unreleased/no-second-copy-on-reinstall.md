## 用户

- 用官方安装方式或别的办法装好的 Claude Code、Codex、Gemini CLI，在「安装卸载」页不再给「重新安装」，旁边写明该怎么更新；以前点一下会在旁边再装一份，两份抢着用，版本对不上。

## 开发

- `pages-maintenance.tsx`（#481）：与首页同一判定 `isExternallyManagedInstall`，原生/其他来源的 CLI 禁用「重新安装」（新增 `maintenance-install-<id>` testid），说明改用 `externalInstallHint`。
- `system-service.ts`：`installCliOperation` 开头新增 `assertNpmChannelOwnsCli`，按首页同一 npm 全局根判定来源，原生/其他来源直接拒绝（纯函数 `externalCliInstallRefusal`），探测失败不拦；Grok 不受影响。浏览器夹具新增 `nativeInstall`，补单测与浏览器回归。
