## 用户

- Codex 支持 GPT-6.2，站上新上的模型也能直接用。
- 手机遥控 Codex 更好用：能发图片、看进度，打开星芒时可以自动连上。
- 画布新增视频抽帧、局部重画，一次能出好几张图挑着用。
- 视频剪辑能加配乐、转场和字幕。
- 配置文件坏了时可以一键修好。
- 修复已知问题，运行更稳定。

## 开发

- 0.2.24 给客户看的更新说明由产品所有者 2026-11-18 定稿为上面 6 条：原先 60 条太长、解释太细，别的分片的「## 用户」
  全部清空，「## 开发」一个字没动。`scripts/changelog-collect.cjs` 新增 `assertUserNotesNotFinalized`：目录里有
  `final-user-notes.md` 时，`changelog:check` 和 `changelog:collect` 都拒绝别的分片再带「## 用户」，以后合进来的改动只写
  「## 开发」；汇总时这个分片随别的一起删掉，下一版恢复照常。写法见 `changes/unreleased/README.md`。
