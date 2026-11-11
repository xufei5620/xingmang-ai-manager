## 开发

- 聊天页右上角「参数设置」左边加一颗「看做过的图」图标按钮（Fable 第二轮 Q4，产品负责人回「素材库放开」「看图改」）：
  只调画布那半给的 `openCanvasAssets()`（#1737 的 `canvas:open-asset-library`），不另开通道；打不开走
  `perform('打开素材库', …)` 的错误框。`ChatPage` 的 `onOpenAssets` 缺省 = 不出这颗按钮。视频剪辑页不加：
  视频不在这个素材库里。
