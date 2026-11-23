## 用户

- 画布「导出工作流」改为先选择保存位置，保存或导出含视频、音频的工作流时将提示其不包含在文件中；归档项目时可按回车键确认。

## 开发

- 画布内核同步到 xingmang-canvas kernel-v0.1.16（375da9f，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），带进三个 PR，桌面主进程都不用跟着改：
  - xc #59（0.2.25 总单第 10 项后半，yoyo 回「换默认」）：`imageModelPresets` 次序改成 2.6 Flare(推荐) → 2.5 Flare → GPT Image 2 → 2.6 Sunburst → 2.5 Sunburst，账号图片分组里有 2.6 Flare 的新项目默认用它，跟桌面 AI 对话、星芒AI画图（#1803）一样；`defaultImageModel` 不变，已有项目选好的型号不变。
  - xc #58（#1368 第 5 条）：`canvasRenderedEdges` 连线没变就交回原对象和原数组，拖动时 React Flow 不再每帧整份替换连线库；运行按钮旁的预检没有在读的来源就不跑。300 个节点拖动每步脚本 42～52 毫秒降到 30～37 毫秒，行为不变。
  - xc #60（#1368 第 14 条）：素材菜单打不开（素材已删、换了账号）时底部提示原因；`editor/workflow-file-notices.ts` 保存、导出带视频音频的工作流时照实说视频音频不在文件里。导出先弹保存框是主进程那一半，在 #2038。
- v0.1.14～v0.1.16 三个 tag 都是 xingmang-canvas 新加的「Kernel tag」工作流（xc #57）在内核改动合进 main 后自动打的，不再请人去网页建；AGENTS.md T13 补了一句。
