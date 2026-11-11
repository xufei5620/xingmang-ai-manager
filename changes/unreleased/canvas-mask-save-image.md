## 用户

- 画布的蒙版局部修改窗口能把涂好的黑白蒙版另存成图片了：「另存为关联图片节点」「另存为独立图片节点」「保存至当前节点」三种，存进当前项目的素材库。

## 开发

- 画布完善第 7 条第一步（#1397）：新通道 `canvas-host:import-asset-bytes`，画布在页面里画好的图片只交字节、不交路径。preload 的 `importAssetFile` 拿得到磁盘路径（用户拖进来的）照旧走 `import-asset-file`；拿不到路径的，只有 PNG / JPEG / WebP 才读出字节走新通道，名字和类型都不发。
- 主进程（`canvas-byte-upload.ts`）：只收一个 `Uint8Array`，最多 20 MB；按文件头认 PNG / JPEG / WebP，长宽都不超过 8192；每个画布窗口同时最多 2 张、每分钟最多 20 张合计 100 MB，存失败的也算。没打开项目就拒；存进当前项目自己的素材库（没文件夹的老项目进账号素材库），来源记「导入」。不回滚：素材按内容存，同样的字节返回的可能是用户原来就有的那份。
- 打开 `desktopCanvasCapabilities.features.byteUpload`（`canvas-contract.ts` 和 `canvas-preload.ts` 两份一起改），kernel-v0.1.8 的 `maskAssetSave` 跟着它把蒙版的另存按钮放出来，不用改内核、不用建标签。
