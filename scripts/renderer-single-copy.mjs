// U06（2026-10-28 审计）：画布目录 canvas-v2/ 可以单独
// `npm install`（它的 README 这么写，老机器上也可能还留着更早装的那份），装过以后那里有自己的
// react / react-dom / lucide-react / @xyflow/react。根目录的 Vite 依赖扫描默认把仓库里所有 .html
// 当入口，canvas-v2/index.html 也在内；从画布源码出发解析裸包名，Node 的规则先找到画布那份，
// 而预打包只按包名记一份，谁先被扫到用谁（实测同一份目录连跑几次结果不一样）。主界面的开发页、
// 浏览器夹具于是可能拿到画布那份 lucide-react，它再引画布那份 React：一页里两份 React，
// 第一个图标就报 "A React Element from an older version of React was rendered"，页面挂不出来。
// 根目录 vitest 的画布用例同理，会跑在画布目录那份（可能是旧的 React 18）上。
//
// 发布构建不受影响：CI 不在画布目录装依赖，产物模块图里只有根目录那份。
//
// 这里列出的包，根目录的开发服务器、浏览器夹具（e2e/harness.mjs 的 createFixtureServer）和
// vitest 的 renderer-v2、canvas 两个 project 一律从仓库根目录解析（Vite 的 resolve.dedupe），
// 画布目录装没装依赖、装的哪一版都一样。canvas-v2/ 自己一个字不动（AGENTS.md T13）：
// 它的构建配置自带 dedupe，从它自己的根解析，本来就只有一份。
//
// 名单要盖住 canvas-v2/package.json 的全部运行时依赖：内核以后多引一个包，
// scripts/renderer-single-copy.test.cjs 会红，提醒把它加进来。
// 冻结的 legacy 回滚版不用这张表：它在 vite.config.ts / vitest.config.ts 里把 React 明确指到
// tooling/legacy-renderer 那份 React 18，别往那边套。
export const rendererSingleCopyPackages = Object.freeze(['react', 'react-dom', 'lucide-react', '@xyflow/react'])
