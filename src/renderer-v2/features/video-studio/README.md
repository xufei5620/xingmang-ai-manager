# 视频剪辑

把 AI 生成的几段片段拼成一条成片。第 1 期「一句话出片」分三步做：先是本目录的拼片引擎（现在这些文件），再是主进程按分镜出片段，最后是页面。目前还没有页面入口。

## 拼片引擎

`composeInVideoStudioWorker(request, { signal, onProgress })` 在后台线程里拼，页面不卡；`composeVideoStudio` 是同一套，直接在当前线程跑（测试用）。

- **输入**：每段片段的全部字节（MP4 / MOV / WebM）加可选的剪头、剪尾、字幕；成片的画面比例（16:9、9:16、1:1）、清晰度（短边 480 / 720 / 1080）、填充方式（裁边 `cover` / 补黑边 `contain`）和帧率（24 / 25 / 30）。
- **输出**：一个 MP4 的字节、编码、宽高和时长。画面优先 H.264，没有再用 VP9、AV1；声音优先 AAC，Linux 的 Chromium 没有 AAC 编码器，用 Opus。所有片段都没有声音时成片不带音轨。
- **字节会转移**：交给后台线程后 `request` 里的 `ArrayBuffer` 就空了，要重拼就重新读片段。
- **不装 ffmpeg**：解码、编码都用 Electron 自带的 WebCodecs，读写 MP4 用 [mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0，没改它的源码）。
- **上限**：最多 50 段、成片最长 10 分钟、一段最大 512 MB、加起来最大 1 GB；成片整个在内存里组装。

文件：

- `timeline.ts` — 纯计算：成片尺寸、每段从哪儿取、落在成片第几帧。按整帧切，48 kHz 能被每个帧率整除，所以画面和声音拼多少段都不会错开。
- `captions.ts` — 字幕排版：汉字按字断行、英文按词断行，标点不上行首；字号按短边算，竖屏抬到下五分之一；放不下先缩字号再截断。
- `pcm.ts` — 声音拼接：每段先重采样成 48 kHz 立体声再交给编码器，只写这一段自己的时间窗，没有声音的地方是静音。
- `encoding.ts` — 挑这台电脑能用的编码器。
- `compose.ts` — 用 mediabunny 读片段、逐帧画到画布上烧字幕、编码、写 MP4。
- `compose-protocol.ts` — 后台线程两头的消息格式，两边都按白名单读。
- `compose-worker.ts` / `compose-client.ts` — 后台线程本身和页面这一头；取消就直接关掉线程。
- `errors.ts` — 报错上屏一律中文；浏览器抛的英文错误换成一句能照着做的话。

## 验证

```bash
npx vitest run src/renderer-v2/features/video-studio --no-file-parallelism
XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium node --test src/renderer-v2/features/video-studio/browser-check.mjs
```

浏览器测试在页面里现做几段纯色片段（不同尺寸、帧率、有无声音），拼完再解出来量颜色、字幕像素和音量，也核对后台线程、取消和读不了的文件。不碰网络。

Windows / Mac 上能不能编出 AAC 声音要真机看；编不出也会自动换 Opus，照样出 MP4。
