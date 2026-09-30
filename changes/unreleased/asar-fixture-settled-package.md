## 开发

- 修 `scripts/verify-packaged-hardening.test.cjs` 在忙的 CI 上偶发红（#691、#703 各撞一次，指纹「随包更新说明或 package.json 不是有效的 JSON」）。根因在 `@electron/asar` 3.x：`createPackage()` 调完写流的 `end()` 就返回，不等写完，紧接着 `extractFile` 偶尔读到还没落盘的文件体（全 0），被当成坏 JSON。新增 `scripts/asar-fixture.test-support.cjs` 的 `createSettledPackage`：打包后等归档长度达到它自己头部声明的长度再返回（写流按顺序追加，长度够了就是全部写完）。打包校验、macOS 产物校验两份测试与 `e2e/asar-tamper-smoke.mjs` 都改用它；打包校验夹具另把归档放到被打包目录之外。校验脚本本身不改：生产上归档由打包进程写完退出后才校验，不受影响。
