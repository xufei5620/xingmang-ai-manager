## 用户

- 让 AI 工具画图时只用 OpenAI 的图片模型。当前账号能用 OpenAI 新出的图片模型时自动换上，用不了就照旧，不用自己选。

## 开发

- 生图技能（`bundled-skills/xingmang-ai`）去掉即梦和 Gemini：`generate.mjs` 只收 `gpt-image-*`，删掉 Chat Completions 出图和 `extra_fields` 分支；`SKILL.md` / `references.md` 跟着删。画图工具（`mcp-server.mjs`）本来就只放行 gpt-image。
- 登录同步时 `syncXingmangAiSkill` 新增可选的 `fetchAvailableModels`（`ipc.ts` 接 `service.fetchAvailableModels`），拿技能的 Codex Key 和生图分组 Key 各查一次 `/v1/models`，按 `XINGMANG_AI_IMAGE_MODEL_PREFERENCE`（`gpt-image-2.5-flare` → `gpt-image-2`）挑一个写进 `config.json` 的 `model`；都没查到就不写、只进日志。
- `mcp-server.mjs` 和 `generate.mjs` 把它当默认模型；默认模型被中转明确拒了（没渠道、没定价）自动换回 `gpt-image-2` 再试一次，AI 点名的别的型号不换。说明见 `docs/NATIVE-IMAGE-MCP.md`「用哪个模型」。
