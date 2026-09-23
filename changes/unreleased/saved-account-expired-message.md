## 用户

- 在「切换账号」里切到一个登录已经失效的保存账号时，现在会说清是「这个保存的账号登录已失效，当前账号没有变化」，并在那一行给「重新登录这个账号」按钮；以前提示看起来像是当前账号掉线了。

## 开发

- 全面检测 Q12。`realm-account.ts` 新增错误码 `SAVED_EXPIRED`，`realm-account-service.ts` 的 `switchSavedAccount` 在目标账号恢复不了（返回 false 或抛 `UNAUTHORIZED`）时抛它，不再借 `UNAUTHORIZED`；文案刻意避开「登录已过期」「请重新登录」，不会被渲染层归到当前账号过期那一类。`SavedAccounts.tsx` 认出这句后在那一行给「重新登录这个账号」。业务夹具的 `fail=switch` 改抛同一句，回归用例钉住不出现「登录已过期」标题、按钮能打开登录。
