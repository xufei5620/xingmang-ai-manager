## 开发

- #1069 第 5 条、#1073 第 2 条里 python-runtime 那一处：Python 官方发布信息和 Codex 桌面端调试口的目标列表改用
  `bounded-response.ts` 边读边限大小，没声明长度的响应读过上限就停，不再先整个读进内存再比。报错照旧是
  「Python 发布信息响应过大」「CDP 目标响应过大」：`readBoundedResponseText` / `readBoundedResponseBytes` 加了可选的
  `oversizeMessage`，不传时老调用方的报错不变。
