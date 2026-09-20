## 开发

- `scripts/macos-release-keychain.cjs`：`security import` 报口令不对时，补上该查哪三件事。`security` 对「密码填错」「.p12 导出时没设密码」「base64 在传递中掉了字节」报的是同一句话，runner 上没有任何东西能把它们分开——2026-09-20 的正式发布为此白等了一轮审批。指引里不含密码本身，测试钉住了这一点；不提口令的错误原样透传。
