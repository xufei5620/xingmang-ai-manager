# 界面改动记录分片

每个改了界面的 PR 在这个目录下放一个属于自己的文件，写它在 `ui-spec/CHANGELOG.md` 里要记的那一行。
发版时 `npm run changelog:collect` 按日期把这些行汇总进 `ui-spec/CHANGELOG.md` 最上面，并删掉分片。

以前每个界面 PR 都往 `ui-spec/CHANGELOG.md` 最上面加一行，并行的 PR 多，合进去一个其余的就全在那一行冲突；
带冲突的 PR GitHub 不跑 CI，自动合并也悄悄卡住（2026-11-22 #2091 撞了 1 次，#2097 撞了 3 次）。
一个 PR 一个文件，就不会再撞。做法跟 `changes/unreleased/` 一样。

## 怎么写

1. 新建 `ui-spec/changes/<这次改动的短名>.md`，用英文小写和连字符，例如 `wording-batch-14.md`、`create-library-player-size.md`。
   这个 PR 带了 `changes/unreleased/` 分片的，用同一个文件名最省事。不要跟目录里已有的文件重名。
2. 文件里只写记录本身，格式跟 `ui-spec/CHANGELOG.md` 一样，不写标题：

   ```markdown
   - 2026-11-22 · v4.0 · 受控（谁在什么时候同意的）· 改了什么 · 为什么 · 影响的页面
   ```

3. 每条以「- 日期 · 」开头，日期是北京时间的那天；一条写不下时续行缩进两个空格。
   一个 PR 一般一条，改了几块不相干的地方可以写几条。
4. 同一个 PR 后来又改了，直接改自己这个文件；别的 PR 的文件不动。

## 规矩

- **不要直接往 `ui-spec/CHANGELOG.md` 加行**。`npm run changelog:check`（CI 每个 PR 都跑）发现 PR 让那个文件多了记录、
  又不是发版汇总（汇总会同时删掉这里的分片），就会报错，提示把那几行挪到这里。订正已有的旧记录不受影响。
- 本地自查：`npm run changelog:check`，会把这里每个文件都解析一遍，格式不对会指出是哪个文件第几行。
- 汇总时日期新的在上；同一天的几条按文件名排，同一个文件里的按写的先后。
- 看最近的界面改动：先看这个目录（还没汇总的），再看 `ui-spec/CHANGELOG.md`。
- 发版时由发布者执行 `npm run changelog:collect`，它和 `changes/unreleased/` 的分片一起汇总，步骤见 `docs/RELEASING.md`。
  这里的分片不影响发版：`publish-release` 只核对 `changes/unreleased/` 有没有清空。
