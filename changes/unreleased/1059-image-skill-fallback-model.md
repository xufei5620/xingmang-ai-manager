## 用户

- 账号里没有 gpt-image-2.5-flare，也没有 gpt-image-2 时，星芒画图改用账号里有的另一个 OpenAI 图片模型，不再一画就失败。

## 开发

- #1059 第 3 段「画图技能：首选的两个型号账号里都没有时，照样写 gpt-image-2」：`selectXingmangAiImageModel` 两个首选都没有时，
  按新的 `XINGMANG_AI_IMAGE_MODEL_FALLBACKS`（`gpt-image-2.5-sunburst`、`gpt-image-1`）挑账号列表里有的；一个都没有返回 null，
  `config.json` 不写 `model`，日志照旧记「没查到当前账号能用的图片模型」。只在画图脚本 `ALLOWED_MODELS` 里挑，不放宽脚本白名单
  （那条是「画图脚本放开」，等 yoyo）；`gpt-image-1.5` 站上没开放，不挑。加了一条单测钉住挑出来的型号都在脚本白名单里。
