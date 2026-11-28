# 随包的本机放大模型（「变清晰」）

`realesr-general-x4v3.onnx` 是 Real-ESRGAN 作者发布的 `realesr-general-x4v3` 模型，由同目录的 `convert-realesr-general-x4v3.py` 从官方 `.pth` 原样转成 ONNX：权重一个数不改，只换存法。主进程在后台线程里用 onnxruntime 的 WASM 版跑它（`electron/image-upscale-service.ts`、`electron/image-upscale-worker.ts`），把客户点的那张图放大 2 倍或 4 倍、另存进作品库，原图不动。

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/xinntao/Real-ESRGAN> |
| 发布 | `v0.2.5.0` 的 `realesr-general-x4v3.pth`（4,885,111 字节） |
| 源文件 sha256 | `8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292` |
| 转出的 ONNX sha256 | `7c51a397f0826742f70d57eee2db67cd13509d5b0f9c14797b9913d035fa9e80`（4,861,885 字节） |
| 许可 | BSD-3-Clause，`LICENSE` 原样拷自 Real-ESRGAN 仓库根目录；随包的第三方许可清单里有它 |

机器读的记录在 `manifest.json`。

## 为什么不能改

主进程每次跑之前按 sha256 核对模型（`imageUpscaleModelSha256`），对不上就报「提升清晰度失败」，不会拿一份坏模型出一张花图存进客户的作品库；`electron/image-upscale-service.test.ts` 也钉住这个值和 `manifest.json`。

## 怎么重新转一遍

```bash
curl -fLO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
sha256sum realesr-general-x4v3.pth        # 对上上表的源文件 sha256
python3 -m venv venv && venv/bin/pip install numpy onnx onnxruntime
venv/bin/python -I convert-realesr-general-x4v3.py realesr-general-x4v3.pth realesr-general-x4v3.onnx --verify
sha256sum realesr-general-x4v3.onnx       # 对上上表的 ONNX sha256
```

不用装 PyTorch：脚本自己读 `.pth`（只认三种权重相关的类型，别的一律拒绝，读文件不会执行里面的代码），按 `srvgg_arch.py` 的结构一层层写出 ONNX；`--verify` 再拿 numpy 照 PyTorch 的写法算一遍，两边差不到万分之一才算过（2026-11-27 实测最大差 1.6e-6）。

## 运行库

onnxruntime-web 是开发依赖，`npm run compile` 时由 `scripts/stage-image-upscale-runtime.cjs` 只挑后台线程用得到的几个文件放进 `dist-image-upscale/`，随 app.asar 一起打包（约 15 MB）。npm 上的 onnxruntime-web、onnxruntime-common 不带许可文件，`LICENSE.onnxruntime`（微软 onnxruntime 的 MIT 许可）和 `ThirdPartyNotices.onnxruntime.txt`（它用到的第三方组件许可）都原样拷自 PyPI 上官方 onnxruntime 1.31.1 的安装包，和 npm 上的版本一致。两份都由 `scripts/third-party-notices.cjs` 收进安装包里的 THIRD-PARTY-NOTICES.txt。WASM 里静态链进了其中几个组件（比如 Eigen，MPL-2.0），源码在 microsoft/onnxruntime 的 v1.31.1 标签下。

升级 onnxruntime-web 时，这两份要换成同一版本安装包里的，manifest.json 的 `runtime` 一并改。
