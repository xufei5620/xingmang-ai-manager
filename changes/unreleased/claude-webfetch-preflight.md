## 用户

- 用当前账号跑 Claude Code 时，让它读网页不会再失败或干等半分钟。

## 开发

- `electron/config-files.ts`：星芒来源的 Claude `settings.json` 写 `skipWebFetchPreflight: true`（reset 与 merge 都写），切回官方账号时删掉。Claude Code 的 WebFetch 每抓一个域名前先问 `api.anthropic.com/api/web/domain_info`，国内不可达时被拒立即报错、被丢包则等 30 秒后报错；沙箱实测 2.1.277 加上这个键后官方主机不可达也能 1.2 秒抓到。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 管不到这一步。依据见 `docs/CLI-VERIFIED-VERSIONS.md` 的改动表。
