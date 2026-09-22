## 用户

- 点「切到当前账号」时如果服务正在维护，只提示「服务暂时不可用，稍后再试」，原来的配置不动，也不会说成 Key 有问题。

## 开发

- `account-source-switch.ts` 的 `judgeSwitchCheck` 去掉自己按状态码、网页、Cloudflare 特征猜维护的那一套，改认 #387 的统一分类：自检 `service` 层不回滚。签发 Key 或查模型时遇到 `NewApiNetworkError('serviceUnavailable')` / `RealmAccountError('UNAVAILABLE')`，`configureManagedClis` 的失败项带上 `serviceUnavailable`，一键切换据此抛 `AccountSourceServiceUnavailableError`，不恢复备份（配置还没写）。`system-service.ts` 查模型时的维护错误改抛 `NewApiNetworkError`，文案不变。
