## 开发

- Antigravity 接中转第三步，仍只有主进程：`account-cli-provisioner.ts` 加了 `resolveAntigravityManagedKey`，
  给 Antigravity 拿 Gemini 分组的密钥和它此刻能用的型号。和下线的 Gemini CLI 是同一把（同名、同组、缓存里同一格），
  老客户签过的接着用；只在点 Antigravity 时才签，登录那一轮照旧不签。失效重签、额度用完不重签、换组照抄限制的规矩
  和 `configureManagedClis` 一致；账号里认不出 Gemini 分组、分组被拒又没有别的、列不出型号时，报
  「服务暂时不可用」（`AntigravityServiceUnavailableError`，yoyo 11-23 定历史账号也照这一套）。
  缓存里哪几把能直接用的判断抽成了 `usableCachedKeys`，行为不变。
