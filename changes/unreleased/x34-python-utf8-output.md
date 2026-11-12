## 开发

- Windows 上从星芒打开的工具窗口里，客户自己没设过 `PYTHONIOENCODING`、`PYTHONUTF8` 时补一个
  `PYTHONIOENCODING=utf-8`（`provider-launch-service.ts` 的 `withPythonUtf8Output`，叠在颜色层之上）。
  中文 Windows 上 Python 3.14 及以前把输出接到管道时按 GBK 编码，Claude Code、Codex 跑命令都是接管道读输出，
  AI 写的脚本一打印 ✅ 就报 `'gbk' codec can't encode`，不报错的中文也成乱码，AI 多花一轮重跑。只改标准输入输出，
  不设 `PYTHONUTF8=1`（那会连 `open()` 读文件的默认编码一起改）；设过的不论什么值都照旧，变量名不分大小写。
  管理员身份那条路的基底仍是 `trustedCommandEnvironment`，这一层只加一个写死的值，被基底去掉的变量不会回来（T4）。
  Mac、Linux 不变（D77，深查 中文路径编码 ZW-2）。
