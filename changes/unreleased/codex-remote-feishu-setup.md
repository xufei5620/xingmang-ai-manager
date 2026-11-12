## 开发

- Fable 手机遥控 YF-1：`FeishuRemoteSection.tsx` 填过凭据、还没配对时，「飞书应用」那行下面跟着 `feishuNextSteps`
  （标题、固定 4 步、一句小字，字照批过的原文）；配对成功后换成折起来的「怎么建飞书机器人」，点开是原来的
  `feishuSetupSteps` 六步（和没填凭据时的表单共用 `FeishuSetupGuide`）。原来一保存说明就跟着输入框收走，
  可「事件与回调」「发布版本」两步正要在保存、打开遥控以后才做。只改界面，主进程和快照不动。
