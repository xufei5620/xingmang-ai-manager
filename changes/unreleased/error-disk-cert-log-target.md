## 用户

- 磁盘装满或公司网络替换了证书时，失败面板会直说是哪一类问题该怎么办，不再只给一句英文原文或让你去检查一个本来就通的网络。
- 失败面板的「查看日志」现在按失败的来源落到对应那页：环境类问题去「反馈」页的运行日志，安装本身的失败仍然去「安装卸载」页的安装日志卡，不再打开一张空卡片。

## 开发

- `src/renderer-v2/operation-error.ts` 分类表新增 `diskFull`（ENOSPC 及同类说法）与 `tlsIntercepted`（复用 `electron/network-failure.ts` 的 `classifyNetworkFailure` 归到 `tls` 的那一类），两条都排在 `permission` 与 `timeout` 之前；裸 EPERM 仍归 `permission`、EBUSY 仍归 `toolRunning` 不变。`registry/errors.ts` 补两条目录文案（候选 4）。
- `electron/network-failure.ts` 的 tls 正则补上 npm / OpenSSL 的散句写法（`self signed certificate`、`unable to get local issuer certificate`、`unable to verify the first certificate`、`certificate has expired`、`UNABLE_TO_GET_ISSUER_CERT`、`CERT_UNTRUSTED`），公司网关换证书时账号侧与安装侧的归类口径这才是同一份。
- 新增 `operationLogPage(failure)`：没有 `tool` 的失败（连接检查、写 Key、拉起终端）落 `feedback`；来自安装 / 卸载 / 更新的失败里，只有杀毒拦截、更新包校验和认不出的那几类落 `maintenance`，其余环境类（网络、证书、磁盘、权限、文件占用）同样落 `feedback`。`App.tsx` 的 `runOperationAction` 只查这张表（候选 8）。
