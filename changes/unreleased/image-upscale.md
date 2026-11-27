## 开发

- 「变清晰」（全面方案第 26 件，yoyo 11-27 回「本机变清晰」）：对话里的图和作品库点开的图多一颗「变清晰」，在本机放大 2 倍或 4 倍、
  另存一张进作品库，原图不动，不扣费、不连网。新通道 `chat:upscale-asset`（契约、preload、注册、日志策略四处一致），只收作品编号和倍数。
- 模型随包带 Real-ESRGAN general-x4v3（BSD-3，4.6 MB，`bundled-catalog/image-upscale/`，来源和 sha256 记在 `manifest.json`，读模型时按钉死的哈希核对）；
  运行库是 onnxruntime-web 1.31.1 的 WASM 版，在主进程的 `worker_threads` 后台线程里跑（`image-upscale-worker.ts`），一次只跑一张、
  线程数 min(4, 核数−1)、分块 256 加 24 像素重叠，两分钟没动静当卡住。输入最大 2048×1152，输出不超过 4096×4096 像素数、长边不超过 8192。
- onnxruntime-web 仍是开发依赖：`compile` 由 `scripts/stage-image-upscale-runtime.cjs` 只挑后台线程用到的几个文件进 `dist-image-upscale/`（14 MB，
  不带整包 150 MB），`electron-builder.config.cjs` 把它和模型打进 app.asar；`verify-packaged-hardening.cjs` 出包后核模型哈希和每个运行库文件，
  第三方许可清单登记 onnxruntime-web、onnxruntime-common 和模型，许可文件版本对不上运行库版本时编译失败。
- 测试：纯函数用随机输入核分块拼接和 PNG 编码（自带一个独立的 PNG 解码器对照）；后台线程有真运行库加真模型的用例，服务用真模型字节核哈希；
  `stage-image-upscale-runtime.test.cjs` 在新进程里加载挑出来的那份运行库并真开模型（onnxruntime-common 的 `dist/cjs/package.json`
  少了，Node 会把那几个 CommonJS 文件当 ES 模块读，打包版第一次点就失败）；渲染层浏览器回归覆盖对话和作品库两个入口。
