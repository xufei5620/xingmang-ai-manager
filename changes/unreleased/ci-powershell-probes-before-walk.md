## 开发

- `windows-package` 里「Run the PowerShell probes against this runner once」挪回「Walk every page of the real
  client」之前（#2041）。#1887 把真开客户端走页面那步放到它前面以后，客户端一退出，接下来一两分钟里加载
  Appx 模块的探测会被堵住：约束模式的 Codex 那条约一半运行超过 10 秒，两次跑满 90 秒被掐（#1897、#2000），
  中间不碰 Appx 的探测照常半秒；#1887 之前抽查的 16 次全是 6~8 秒。`scripts/ci-workflow-config.test.cjs`
  钉住先后顺序；那条用例现在每段打出自己的用时，哪段失败或被掐就报哪段，被掐时附上它已经打印的输出。
