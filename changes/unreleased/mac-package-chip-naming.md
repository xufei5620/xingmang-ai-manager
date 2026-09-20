## 用户

- macOS 的两个安装包改用芯片名区分：Apple 芯片的 Mac 下载名字里带 `Apple-Silicon` 的那个，Intel 芯片的 Mac 下载带 `Intel` 的那个，不用再对着 arm64、x64 猜。

## 开发

- 新增 `scripts/macos-artifact-names.cjs`，macOS 产物文件名收口到这一处：electron-builder 仍按 `${arch}` 打出构建名，发行名是 `XingMang-AI-Manager-<版本>-Apple-Silicon-arm64.*` 与 `…-Intel-x64.*`。架构后缀刻意保留——electron-updater 的 `MacUpdater.filterFilesForArch` 靠更新文件 URL 里是否含 `arm64` 子串分架构下载，`e2e/macos-launch-smoke.mjs` 与产物校验按 `-<架构>.zip` 结尾匹配，单测把这条钉住。
- 新增 `scripts/rename-macos-chip-artifacts.cjs`：在 `dist:mac:free` 的构建（含带加速线路时的分架构合并）之后、产物校验之前，把六个产物改成发行名并同步改写 `latest-mac.yml` 的 `files[].url` 与 `path`。改名全程只移动文件、不碰字节，摘要与体积原样成立；缺文件、目标名已存在、清单版本对不上都在移动任何文件之前失败。
- `verify-macos-free-artifacts.cjs`、`update-release-utils.cjs` 的 macOS 更新清单库存核对、`publish-dl-landing.cjs` 的安装包文件名都改读新模块；`merge-macos-free-artifacts.cjs` 合并的仍是改名前的构建名。
- electron-builder 的 `artifactName` 只有 `${arch}` 一个架构宏（`app-builder-lib/out/util/macroExpander.js`），没法把 arm64 映射成芯片名，而本机构建可能一次打两个架构，所以改名做成构建后的独立一步，而不是配置项。
