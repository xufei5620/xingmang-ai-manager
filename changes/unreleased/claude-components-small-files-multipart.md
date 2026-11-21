## 开发

- Claude 桌面端组件同步（`sync-claude-components-cos`）1 MiB 及以上的文件都改走分块并行上传，不再等通用的 16 MiB 起点（#2069）。
  11-21 两次定时同步里 GitHub 的机器往上海一条连接只有 10~18 KB/s，约 15 MB 的 `vmlinuz.zst` 一次性 PUT 要 14~20 分钟，
  COS 回 HTTP 400 或等不到回应，Windows 工作区两部分连着红；`createCosStore` 加可选的 `multipartMinBytes`（只能调低，缺省照旧 16 MiB），
  别的同步不受影响。
