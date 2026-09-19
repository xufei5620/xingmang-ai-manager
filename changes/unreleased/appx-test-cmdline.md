## 开发

- `electron/codex-desktop-appx.test.ts` 的两条 Windows 专有用例不再把生成的 PowerShell
  脚本塞进 `-EncodedCommand`：脚本与待解析的 JSON 现在写到临时目录，用
  `-ExecutionPolicy Bypass -File` 调用。解析用例原先的命令行约 28 KB（UTF-16LE 再 base64
  会把脚本放大 8/3），离 Windows 32767 的命令行上限只剩一点余量，在并行分片的 runner 上
  偶发起不来子进程；SID 门用例原先也有 9 KB。新增一条跨平台用例把最终命令行长度钉在
  cmd.exe 的 8191 以下。
