## 用户

- 安装包瘦身：去掉了用不上的外语文件，Windows 版安装包小约 7 MB、装好后少占约 47 MB 硬盘，Mac 版装好后少占约 8 MB。

## 开发

- `electron-builder.config.cjs` 加 `electronLanguages`：浏览器内核自带的 55 种语言只留 `zh-CN`、`zh-TW`、`en-US`（en-US 是
  Chromium 认不出系统语言时的退路）。macOS 按 `.lproj` 的名字另列在 `mac.electronLanguages`（`zh_CN`、`zh_TW`、`en`），
  连同这三种语言各自的 `_FEMININE` / `_MASCULINE` / `_NEUTER` 空壳目录（18 字节，桌面版 Chromium 还不读）原样留着。
  出处：Rust 评估报告（`/mnt/project-files/Rust评估/报告.md` 第五节第 3 条），yoyo 10-30 回「删语言包」。
- 省下多少（Electron 45.1.0）：Windows 删掉 52 个 `.pak` 共 49.4 MB（装好后），按安装包同样的 LZMA2 最高档压缩约 7.5 MB；
  macOS 每个架构删掉 208 个文件共 8.0 MB，dmg / zip 里约 2.3 MB（按 zlib 估算）；Linux 实测 deb 从 106.06 MB 到 104.34 MB，
  装好后少 7.7 MB。
- 行为：中文（含香港、澳门落到的繁体）和英文系统什么都不变；系统语言是别的（日文、德文、英式英文……）时，浏览器内核自己的
  那点文字（表单校验提示、文件选择框这类）从那种语言变成英文，`app.getLocale()`（反馈报告里的「语言」一行）也报 en-US。
  服务器按请求语言翻译报错，只认中文简繁和英文、别的都回英文，所以客户看到的服务器提示不变。Linux 上用 Electron 45.1.0
  实测过 zh_CN / zh_TW / zh_HK / en_US / en_GB / ja_JP / de_DE / C 都能起来。
- 新增 `scripts/electron-languages-config.test.cjs`：钉住三份名单，并核对每个留下的名字都是本机装的 Electron 真带的
  （名字写错 electron-builder 不报错，会把本该留的那份一起删掉）。
