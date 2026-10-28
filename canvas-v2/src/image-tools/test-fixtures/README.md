# Camera Raw XMP 测试样例

这四份文件是 K0-1（#2）补进仓库的测试夹具。原来的测试读作者本机工作区里仓库外的 `outputs/` 目录
（`color-presence-20261018`、`color-grade-workflow-20261016`、`color-detail-workflow-20261018`、
`color-calibration-20261018` 下的参考导出），干净克隆和 CI 里没有这些文件。

原始导出不在仓库里，这几份是按 Camera Raw 设置文件的结构、照测试里断言的数值**重新写的样例**，不是原件：

| 文件 | 原来的位置 | 内容 |
|---|---|---|
| `effects-positive.xmp` | `outputs/color-presence-20261018/reference/effects-positive.xmp` | 纹理 60、清晰度 40、去除薄雾 30 |
| `reference-own-settings.xmp` | `outputs/color-grade-workflow-20261016/reference-own-settings.xmp` | 曝光 +1、色温 6500、色调 +15、自然饱和度 +20，其余基本参数和原色校准为 0，带两个本工具不支持的晕影字段 |
| `reference-detail-edited.xmp` | `outputs/color-detail-workflow-20261018/reference-detail-edited.xmp` | 锐化 80 / 1.5 / 40 / 35，明亮度降噪 70，颜色降噪 60，另外四个降噪参数不写 |
| `calibration-combined.xmp` | `outputs/color-calibration-20261018/reference/calibration-combined.xmp` | 六个原色校准值，不写阴影色调和处理版本 |

找到原始导出时，直接用原件替换同名文件；测试的断言不用改。
