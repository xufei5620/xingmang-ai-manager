## 开发

- 登录后主界面（`Shell.tsx`）背后不再挂 `<Starfield quiet />`。它整窗 canvas 每秒重画 10~30 次，且每个刷新周期都跑一次 requestAnimationFrame，沙箱（软件绘制）实测星芒窗口在最前面时界面进程约 8%、显卡进程约 10%，去掉后两边都降到 0.1%。v4 原型主界面本来就没有星空，yoyo 10-15 拍板去掉。`Starfield` 组件和欢迎页的星空不动；`app-check.mjs` 里钉住工作区星空帧率的用例改成钉住工作区不再有 canvas。
