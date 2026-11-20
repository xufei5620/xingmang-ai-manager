## 用户

- 命令行工具里画图、改图失败又没有具体原因时，不再只显示一串英文代号，会说清是哪个模型没画成、接下来怎么办。

## 开发

- 0.2.25 总单第 51 项（Mac 验收 R9）：new-api 拿不到上游原因时，用错误类别名充当原因（`relaykit/types/error.go` 的
  `ToOpenAIError`：message 为空就填 `openai_error`、`upstream_error` 这类），生图技能 `generate.mjs` 和画图工具 `mcp-server.mjs`
  以前原样交给 AI，Grok 改图失败客户只看到 `openai_error`。现在空原因、`*_error` 类别名、只有状态码（比如网关回的 HTML）
  都换成「〈模型〉这次没能出图/改图，图片服务没说原因」，Grok、Nano Banana 建议换回默认的 GPT 图片模型，gpt-image 建议稍后再试；
  画图工具把原话写进 stderr（宿主记日志、不进对话），命令行脚本不打原话。上游把原因写成字符串 `error`（xAI 的格式）时照旧原样交出，
  以前这种会被当成只有状态码。两个脚本同一套判断和句子，`scripts/xingmang-image-mcp.test.cjs` 钉住。
