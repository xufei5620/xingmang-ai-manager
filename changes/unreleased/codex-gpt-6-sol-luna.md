## 用户

- Codex 默认安装的版本更新到 0.156.1，可以正常使用 GPT-6 Sol 和 GPT-6 Luna 两个新模型，不再弹英文警告。当前账号开通了这两个模型时，在 Codex 配置里的「默认模型」就能选到。

## 开发

- `electron/cli-verified-versions.ts`：Codex `recommended` 从 0.155.1 抬到 0.156.1。0.156.1 起自带的模型目录才有 `gpt-6-sol` / `gpt-6-luna`；0.155.1 用它们会走 fallback metadata（旧提示词、旧工具集）。沙箱本地假接口实测过请求体、`codex doctor`、关统计与官方主机丢包，细节见 `docs/CLI-VERIFIED-VERSIONS.md`。没在中转上真跑。
