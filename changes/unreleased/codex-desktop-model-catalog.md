## 用户

- 用星芒账号时，Codex 桌面端的模型菜单里找不到 GPT-6.1 Sol 的问题修好了：星芒会把你账号能用的 GPT 型号交给 Codex，桌面端和命令行的菜单都能选到。升级后先完全退出 Codex，再打开一次星芒就会补上（自己填写密钥的，重新保存一次 Codex 配置）；之后桌面端要完全退出再重新打开才看得到。
- 从星芒打开 Claude Code 时，账号新上的 Claude 型号没进菜单、Claude Code 还被标成「手动填写密钥」的问题修好了（已经被标成这样的，重新选一次星芒账号的密钥即可）。

## 开发

- 根因：用星芒 Key 时 Codex 的菜单、提示词与工具只取二进制自带的型号名单（`codex-rs/models-manager/models.json`）。2026-09-30 那批桌面端（26.930.x）自带 Codex 0.159.0-alpha.12.1，名单里没有 9-29 才上的 `gpt-6.1-sol`；上游同样的报告见 openai/codex #50282。
- 新增 `electron/codex-model-catalog.ts`：随包一份 openai/codex `rust-v0.160.0` 的官方名单（`bundled-catalog/codex-models/`，原样拷贝、按 sha256 钉住，附 Apache-2.0 的 `LICENSE` / `NOTICE`），按 `/v1/models` 挑出当前 Key 能用的型号，原样写成 `CODEX_HOME/xingmang-models.json`，`config.toml` 顶层写相对路径 `model_catalog_json = "xingmang-models.json"`。
  名单文件与 `config.toml` 同一次两阶段提交、文件先落盘，内容没变不重写；不进 `providerConfigPaths`（工具配置来源指纹不变）。
- 名单读不进去时 Codex 命令行起不来、桌面端开不了新对话，所以下面任何一条成立就不写，并收回本软件那一行：账号的型号一个都对不上或只剩隐藏型号；默认型号不在名单里；本机 Codex 命令行低于 max(0.147.0, 写进去的型号的 `minimal_client_version`)；桌面端早于 26.917 那一批（Windows 问 Appx 包、Mac 看应用包，版本号前两段即批次）；名单文件的位置被换成了链接（Key 照常保存）。读不出命令行或桌面端版本时原样不动；用户自己设的 `model_catalog_json` 不碰；切回 ChatGPT 与存官方快照时去掉那一行，名单文件不删。
  沙箱里用假中转跑过七个真二进制（0.146.1、0.147.0、0.150.0、0.153.4、0.156.1、桌面端 26.930 自带的 0.159.0-alpha.12.1、0.160.0）：0.147.0 起都读得进、菜单列出 `gpt-6.1-sol`、请求不再退回通用提示词；0.146.1 报 `missing field base_instructions` 起不来；文件丢了或是空名单时命令行退出、桌面端新对话报 -32600。
- 何时按账号写：`saveConfig` 的每次 Codex 保存；打开前的每日核对（`tool-model-check.ts` 由只管 Claude Code 菜单扩到 Codex，`pickerOutdated` / `refreshPicker` 改为带 provider）；登录状态下开机一次（`syncPicker('codex')`，与补模板缺省项同一套规矩：只动来源是当前账号的配置，Codex 开着或看不出开没开就跳过，改之前先做「保存前」备份）。无新增 IPC 通道。
- 何时在本机就地收回（`takeBackUnreadableCodexModelCatalog`，不看账号、不联网、不管工具开没开，只删本软件那一行，其余字节原样）：Codex 命令行装好 / 更新 / 退回之后（在安装队列任务里，排在后面的启动不会先撞上）、星芒装好桌面端之后、每次从星芒打开 Codex 之前（最多等 3 秒；名单好好的时候先不拿写配置的锁看一眼，不排在别的写入后面）、开机那次（`guardCodexModelCatalogAtStartup`，`main.ts` 开机后调，没登录也做；登录状态下开机那轮按账号同步共用这一次）。名单文件丢了、读不进，或读它的命令行 / 桌面端太旧时收回。命令行与桌面端版本 30 秒内复用一次探测（系统时间往回拨也重探），星芒自己装卸过就作废；装好命令行或桌面端之后当天那次核对也作废（`toolModelChecker.forget`），版本够了下次打开就按账号补上。
- 顺带修 #562 起（0.2.12、0.2.13 都带着）的老问题：打开前核对刷新菜单时，`refreshPicker` 把核对的 `assertCurrent` 交给 `saveConfig`，而 `saveConfig` 写之前先把来源记录改成「手动」，`assertCurrent` 按来源记录认人，于是每次都在写到一半时报「账号已变化，这次核对作废」，Claude Code 菜单一次没刷成过，来源记录还停在「手动」（之后账号切换、换分组都不再自动改 Claude Code 的 Key）。核对新增 `identity` 依赖，只给交到 `refreshPicker` 手里的 `assertCurrent` 用，认人只看站点、账号、Key、型号；写之前的几道核对照旧要求来源是当前账号，写入当中由 `saveConfig` 的自动写入那道闸进锁时把关。已经被改成「手动」的旧配置这次不自动改回。
- 已知限制：随包名单要随 Codex 推荐版本一起换（`docs/CLI-VERIFIED-VERSIONS.md` 每周巡检一节）；中转开了随包名单里没有的新 GPT 型号，下一版带上新名单之前菜单里看不到；自己填写密钥的配置不会被自动重写；IDE 插件自带的 Codex、不在 PATH 上的另一份命令行太旧时星芒看不出来，正式版和 Beta 版桌面端同时装着时只按正式版判断；卸载星芒不收回这一行（与 Key 一样留着，Codex 照常能用，只是名单不再更新）。桌面端菜单在 Windows / Mac 真机上还没看过。
