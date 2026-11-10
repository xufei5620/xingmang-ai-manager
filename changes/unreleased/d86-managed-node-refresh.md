## 开发

- D86（0.2.24 深查决定单，装工具和更新.md S-3）：Mac、Linux 上星芒代装的 Node.js 比钉的版本
  （`macos-node-runtime.ts` / `linux-node-runtime.ts`）旧时，装或更新命令行工具前，在同一个安装
  队列任务里静默换成钉的那版（`runtime-install-service.ts` 的 `refreshOutdatedManagedNodeRuntime`，
  由 `cli-install-service.ts` 在找 npm 之前调）。只换产品目录里代装的那份、而且它正是星芒这会儿用的
  那个 node：客户自己装的不碰，Mac 上客户自己那份够新时代装的那份轮不到，也不白下。版本报不出、
  比钉的新都不动；没换成只记运行日志，照旧用原来那份装工具；客户取消照常说「已取消」。Windows 不变
  （D88 交 Claude·win）。
