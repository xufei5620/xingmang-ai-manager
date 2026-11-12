## 开发

- 给客户看的那句并进了 `cli-verified-2026-11-09.md` 的「## 用户」（一版最多 60 条）。
- 生图技能（`bundled-skills/xingmang-ai`）升级：默认链 `gpt-image-2.6-flare → 2.5-flare → 2`，备选 `2.6-sunburst → 2.5-sunburst`，去掉 `gpt-image-1`；
  主进程（`xingmang-ai-skill.ts`）登录同步时把账号列表里有的整串写进 `config.json`（`model` + 新字段 `fallbackModels`），
  两个脚本默认模型失败按它依次往下退，只退到账号有的；老配置没有 `fallbackModels` 照旧只退到 `gpt-image-2`。
  AI 对话的 `DEFAULT_IMAGE_MODELS`、`IMAGE_GROUP_MODEL_ORDER` 跟着同一个顺序，测试钉住三处一致。
- `generate.mjs` 失败不再直接 `process.exit`（Windows + Node 24 上 fetch 句柄没关完会打 libuv Assertion、退出码 127），改成 `exitCode = 1` 正常退出；
  成功后 stderr 打「已用 <模型> 出图」，stdout 仍只打路径；超时管到读完响应体。
- 两个脚本点名可用 Nano Banana（`nano-banana-2` / `gemini-3.1-flash-image`、`nano-banana-pro`，走 `/v1beta/models/{model}:generateContent`，`x-goog-api-key`）
  和 Grok（`grok-imagine-image*`，Images API + `response_format: b64_json`，实测只出 1280x720、不传尺寸），只用图片模型分组 Key；
  认型号三处同步加 `GEMINI_IMAGE_MODEL_PATTERN`、`GROK_IMAGE_MODEL_PATTERN`。点名认不出或已下线（`gpt-image-1*`）的型号时报错列出能用的。
- 新参数：`--size 1K|2K|4K` 配 `--aspect`（换算成比例不变、16 倍数、总像素 655,360–8,294,400 的宽高），`--background`，多张 `--image`（`image[]`）；
  画图工具同样加 `aspect`、1K/2K/4K。默认画质 `low` 改成 `high`（实测 2.6-flare 三档各 3 张：low 25.9 秒、medium 27.5 秒、high 24.4 秒）。
