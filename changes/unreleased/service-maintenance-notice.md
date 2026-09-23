## 用户

- 服务维护时，软件右上角会直接说「服务正在维护」，并告诉你不用重新登录、也不用改设置；没登录时在欢迎页和登录框里也看得到。

## 开发

- 更新目录上新增 `service-status.json`（`electron/service-status.ts`）：启动时后台读一次，之后每 15 分钟、维护期间每 5 分钟读一次，读不到当没在维护；结果挂在 `UpdateSnapshot.serviceMaintenance` 上推给渲染层，角落提示与登录框各一份。发布者用新的 `service-status` 工作流（release 环境审批）一键开关，格式与步骤见 `docs/SERVICE-STATUS.md`。
