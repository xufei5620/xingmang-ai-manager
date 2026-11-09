## 用户

- 视频剪辑：拼成片时可以「加配乐」，从电脑里选一首歌（MP3、M4A、WAV、OGG）当背景音乐。歌比成片短就从头接着放，结尾 2 秒自动淡出；片段原来的声音可以照常、调小或关掉。同样在电脑上拼，不花钱。

## 开发

- 视频剪辑「拼成一条视频」卡加「加配乐」/「换一首」/「不用配乐」和「片段原声」照常 / 调小 / 关掉（yoyo 2026-11-09「配乐改」）。主窗口业务通道新增两条：`video-studio:pick-music`（主进程弹系统对话框，经 `AiAudioAssetStore.storeLocalFile` 存进作品库的音频那一格，回编号、歌名、时长；路径不来自渲染层，认不出的文件统一报「这首歌读不出来…」，存不进保存位置照原话）和 `video-studio:read-music`（按编号读回字节，和 `video:read-clip` 同一队、成功不记日志）；契约、preload、`ipc-channel-policy.ts`（都等账号）和 `ipc.test.ts` 的两份点名单一起改。拼片引擎新增 `music.ts`：跟着 `pcm.ts` 按顺序交出的声音块往下解这首歌，不回头、整首不一次解进内存，放完从头接，结尾淡出，混进原声后截到 [-1, 1]；`compose-protocol.ts` 的请求多了 `music`（字节 + 音量，最大 128 MB）和 `clipGain`（原声音量，0 就不读原声）。工程存歌的编号、歌名、时长和原声那一项，读回时逐字段校验；换歌、换原声、不用配乐都会清掉挂着的成片。`music.test.ts`、`compose-protocol.test.ts`、`project.test.ts`、`VideoStudioPage.test.tsx`、`ipc.test.ts` 和 `browser-check.mjs` 两条（引擎：循环、淡出、原声调小 / 关掉、读不出；页面：选歌、取消、读不出、默认调小、拼出来有歌、重开还在）钉住。
