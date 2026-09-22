## 用户

- 加速页现在会记住你上次挑的线路和模式：下次打开软件，加速页直接选中上次那条线路
  （线路上方会写一句「已选中你上次用的线路」），不用每次都重新挑一遍。托盘右键的
  「连接加速」，以及从软件里打开 Codex 桌面端时的自动连接，也都改用你记下来的那条，
  不再一律走「智能分配」。
- 记住的那条线路如果已经下线了，会自动回到「智能分配」并把记录清掉，不会卡在一条连不上的
  线路上。换账号互不影响，各记各的。

## 开发

- 新增 `electron/acceleration-preference-store.ts`：按账号 scope 落一份
  `acceleration-preferences.json`（原子写、单文件、最多 64 个账号，超出时丢最久没动过的
  那几条）。记的是**用户亲手选的那一条**而不是上次实际连上的那条——选「智能分配」时后端
  自己挑出来的线路是后端的选择，不该被记成用户偏好，所以 `lineId: null` 是有效记录。
  读坏了一律降级成「从没选过」，绝不抛错：这份数据丢了最多是少记一次偏好，与免费时长账本
  不是一个量级。不入 `settings.json`，因为那份会整份交给渲染层（`electron/acceleration-preference-store.test.ts`）。
- `acceleration-contract.ts` 新增 `AccelerationPreference` / `AccelerationPreferenceUpdate` /
  `AccelerationPreferenceApi` 与 `isAccelerationLineId`；`acceleration-service.ts` 实现这两个
  方法并做入参校验（I5），**刻意不走它那条串行队列**：队列里排着的可能是一次十几秒的连接，
  界面点一下线路不该等它。新增 IPC 通道 `acceleration:get-preference` /
  `acceleration:save-preference`（按字段更新，线路与模式两处界面互不覆盖）。
- `tray-acceleration.ts` 与 `codex-desktop-acceleration.ts` 的 `connect` 多收一个当前状态，
  由宿主（`main.ts`）把记住的选择落到一次真正的连接上。模式只在状态明确报了
  `supportedModes` 且包含它时才跟着走，报不出就用标准模式：托盘与自动连接都是静默发起的，
  不能因为一份旧记录就替用户改系统网络设置（TUN 仍然不开）。
- 渲染层 `features/acceleration/lines-controller.ts` 在拿到第一份线路列表时套用记住的线路，
  之后的刷新沿用界面上的选择（偏好写入是异步的，再读一次会把刚选的那条弹回旧值）；
  记住的线路不在列表里就回退智能分配并清掉记录。`controller.ts` 同样在首次读状态后套用
  记住的模式，用户这次动过开关就不再套用。读写偏好失败一律吞掉，不影响连接与界面。
