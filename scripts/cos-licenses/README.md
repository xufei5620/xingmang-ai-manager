# 存储桶里转发的开源工具的许可文件

星芒的腾讯云存储桶原样转发两样开源工具：Windows 版 Grok CLI（`grok.exe`）和 Mac 版 OpenCode 桌面端（`.app.tar.gz`）。
两家的许可都允许转发，条件是许可文字跟着程序走，所以同步脚本把这里的文件一起传进桶，写进各自清单的 `license`
（决定单 D98，yoyo 2026-11-11「决定单照推荐」，即「桶照旧」）。上传和清单格式见 `scripts/cos-license-files.cjs`
和 `docs/COS-SYNC.md`。

这里的每个文件都是上游原样的字节，不改一个字；`scripts/cos-license-files.test.cjs` 按 SHA-256 钉住。

| 文件 | 许可 | 从哪来 | SHA-256 |
| --- | --- | --- | --- |
| `grok-cli/LICENSE.txt` | Apache-2.0 | `https://www.apache.org/licenses/LICENSE-2.0.txt`。xAI 的 npm 包 `@xai-official/grok` 和 Windows 两个平台包 `grok-win32-x64`、`grok-win32-arm64` 的 1.0.52、1.0.77 都写 `"license": "Apache-2.0"`，但包里不带许可原文（2026-11-11 核过 1.0.77） | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `grok-cli/THIRD_PARTY_NOTICES.md` | 第三方声明 | `@xai-official/grok-win32-x64@1.0.77` 包里的同名文件。`grok.exe` 里嵌着 ripgrep，还移植了 Codex（Apache-2.0）、OpenCode（MIT）的代码，这些声明要随程序带上。2026-11-11 核过 1.0.52、1.0.77（x64、ARM64）、1.0.80 四份，内容一字不差 | `e8785a6098a7ee780cd2db35745b8e53061cfb1b6da19147a308579466ea4e50` |
| `opencode-desktop/LICENSE.txt` | MIT | npm 包 `opencode-ai@1.19.5` 里的 `LICENSE`。2026-11-11 列过 1.19.5 的 `opencode-desktop-mac-arm64.app.tar.gz` 里的文件：只有两个依赖库各自的许可，没有 OpenCode 自己的（`app.asar` 里面没拆开看） | `625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b` |

## 什么时候要改

- 上游换了许可或改了声明（比如 xAI 的 `THIRD_PARTY_NOTICES.md` 多了一个库）：把新文件原样拷进来，改测试里钉的 SHA-256，
  再改上表。下一次同步会把新文件传到新的 `sha256-<摘要>/` 目录、清单指过去，旧文件留在桶里不删。
- 要再放一份文件：加进 `cos-license-files.cjs` 的 `LICENSE_SETS`，同上。
- 文件一律存 LF（`.gitattributes`），Windows 和 Mac 两台同步机器算出来的摘要才一样。
