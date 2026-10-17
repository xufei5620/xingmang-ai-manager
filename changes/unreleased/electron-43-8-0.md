## 开发

- Electron 从 43.6.0 升到 43 线最新的 43.8.0（#1088），不跨大版本，别的依赖不动。Chromium 底版仍是 150.0.7871.250，两版之间 Electron 往 Chromium 补了 139 个、往 V8 补了 29 个上游回移（按 electron 仓库 `patches/chromium/.patches`、`patches/v8/.patches` 两个标签之间的差异数的，各条对应哪些漏洞没逐条核）；自带的 Node 从 24.20.0 到 24.22.0。V8 仍是 15.0，冒烟里「inspector promise 被回收」那件事不会因此消失。Dependabot 按 yoyo 10-17 的决定先不开。
