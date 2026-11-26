## 开发

- 「创作」左边一列最下面的「历史视频读取失败」后面加「重新读取」，点了再读一遍视频列表，读出来那行字就没了（`useVideoStudioLibrary` 新增 `reload()`，`ChatPageCreate.notes` 改成 `{ text, retry? }`）。之前要换账号或重开软件才会再读；画布那一类照旧只有一行字（创作页复查第 9 条，yoyo 11-26 回「视频重读按钮」）。
