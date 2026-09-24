## 用户

- 画布里把图片改成 2K、4K，或者改了视频的清晰度、画面比例、生成方式、提示词优化后再运行，会按新设置重新生成，不会再拿出之前的旧结果；没改过这些设置的节点照旧直接用已有结果，不会多扣费。

## 开发

- `electron/canvas-fingerprint.ts`：节点缓存指纹加入 `imageResolution` 与 MiniMax 的 `videoMode` / `videoResolution` / `videoAspectRatio` / `promptOptimization`，图版本同步加入后四项（#485，D11 = E-S5）。取值等于执行器默认值（模型默认清晰度、`auto`、`720p`、`16:9`、关闭）时不进指纹，已有缓存的键不变，升级后不会整批重跑扣费；非 MiniMax 模型不发送的视频参数也不进指纹。
