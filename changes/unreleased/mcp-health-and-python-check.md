## 用户

- 外接工具页现在会告诉你每条连接到底能不能用：Claude Code 和 Gemini CLI 的连接会标上
  「能连上」「连不上」，连不上的还会写出原因；工具本身不给状态的（Codex CLI、Grok CLI）
  标「未检测」，不替它猜。检测只在打开这一页、换工具或点「重新检测」时跑一次。
- 添加要用 Python 或 uvx 启动的连接时，如果这台电脑还没装 Python，会先提示一句，
  Windows 上可以直接点「自动安装 Python」。想先加上也可以，提示不拦着。

## 开发

- 第六批候选 3 与 5。新增 `extensions:check-mcp-health` 通道与
  `ProviderExtensionService.checkMcpHealth()`：Claude Code / Gemini CLI 跑一次不带 `--json`
  的 `mcp list` 并解析它们自己打印的状态词，其余 Provider 直接回 `supported: false`。
  状态词取自 2026-09-22 沙箱里实跑的 claude 2.1.278 与 gemini 0.60.0 输出，测试用例原样钉住。
- 检测超时单列 `MCP_HEALTH_TIMEOUT_MS = 120s`：`claude mcp list` 会真的把每个 stdio 服务
  拉起来，且它自己对每个服务等满 30 秒，沿用 30 秒的通用超时会让整批落回「未检测」。
  也因为有这个代价，检测没有并进 `list()`——那一条在每次安装、卸载、开关之后都会重跑。
- `ProviderExtensionsSnapshot` 增加可选 `runtimes: { python, uv }`（`findExecutable` 探
  `python3` / `python` / `py` 与 `uvx` / `uv`），渲染层据此在添加连接与精选确认框里提示缺环境。
  缺 uv 时不假装装 Python 能解决，只在同时缺 Python 时才给安装按钮，复用既有的
  `runtime:install-python`，不新增安装通道。
