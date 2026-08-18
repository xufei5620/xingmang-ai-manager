# Canvas Industry Template Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前三套平铺模板升级为可按行业发现、可在插入前配置、生成数量与真实付费请求一致的 20 套行业任务模板包，同时保持画布主进程付费执行和安全边界不变。

**Architecture:** 采用“一个显式生成节点 = 一个结果 = 一个付费请求”。所有原稿中的 `count: 2/4` 展开为并行节点，避免引入未验证的 provider 批量参数。新增 registry 驱动的模板校验、行业目录、能力解析、模板配置器与 Gallery 多输入汇总；模板仍由 renderer 组装，但运行、凭据、资产和网络继续完全归 Electron 主进程所有。

**Tech Stack:** Electron 43、React 18、TypeScript 5.7、Vite 8、Vitest 4、`@xyflow/react` 12、Node test runner、Playwright Electron。

## Global Constraints

- 基线分支：`claude/session-1-5l68rp`，计划编写时 HEAD 为 `9d404183ca6777ff5c4e1074df8c52bacf651ec1`。
- 实现前先阅读 `CLAUDE.md`、`docs/superpowers/specs/2026-08-18-canvas-industry-template-pack-design.md` 与本计划。
- 不在 renderer 中新增 relay 网络请求、Authorization、API Key、token、cookie 或凭据 getter。
- 所有付费 AI 请求继续通过 `window.xingmangCanvasHost` 进入 Electron 主进程。
- 不增加通用 `count/n`；图片多候选使用多个显式节点。
- 视频模板只写 `seconds: '1'..'15'`，不再写 `durationSeconds`。
- 模板绝不自动运行；插入与运行必须是两个独立用户动作。
- 自动测试不得访问生产 relay；真实网络只用于单独人工真机验收。
- 不把调研竞品的源码、截图、文案、提示词、模板或视觉资产放进仓库。
- 每个实现任务使用 TDD：先写失败测试、运行确认失败、写最小实现、运行确认通过。
- 每个任务完成后运行该任务列出的聚焦测试，再提交一个独立 commit。
- `dist-canvas` 是构建产物，不手工编辑，不提交。

---

## File Structure Map

### Existing files to modify

- `canvas-v2/src/App.tsx`：模板入口、节点配置投影、插入画布。
- `canvas-v2/src/model.ts`：`WorkflowNodeData`。
- `canvas-v2/src/models.ts`：模型能力与可用预设。
- `canvas-v2/src/domain/builtin-node-definitions.ts`：节点默认数据与端口真相源。
- `canvas-v2/src/templates/template-types.ts`：模板 schema。
- `canvas-v2/src/templates/instantiate-template.ts`：变量绑定、ID 重映射、模板放置。
- `canvas-v2/src/templates/builtin-templates.ts`：兼容聚合入口。
- `canvas-v2/src/templates/templates.test.ts`：模板基础契约。
- `canvas-v2/src/components/NodeLibrary.tsx`：左侧模板入口。
- `canvas-v2/src/components/QuickInsert.tsx`：快速插入模板入口。
- `canvas-v2/src/styles.css`：目录、配置器与响应式样式。
- `canvas-v2/src/runtime/run-preflight.ts`：运行前付费请求摘要。
- `electron/canvas-node-executors.ts`：生产 Gallery/output/pass-through 行为。
- `electron/canvas-run-engine.ts`：生产 DAG 输出与缓存选择。
- `electron/canvas-run-service.ts`：cache resolver/store 接入。
- `docs/canvas-third-party.json`：官方模板来源台账。
- `scripts/verify-canvas-provenance.test.cjs`：模板来源集合门禁。
- `e2e/canvas-editor-smoke.mjs`：Electron 多视口 UI smoke。
- `docs/CANVAS-TEMPLATE-PACK-PLAN.md`：把方向稿修订为与实现一致的产品说明。

### New files to create

- `canvas-v2/src/domain/workflow-node-config.ts`
- `canvas-v2/src/domain/workflow-node-config.test.ts`
- `canvas-v2/src/templates/validate-template.ts`
- `canvas-v2/src/templates/template-catalog.ts`
- `canvas-v2/src/templates/template-catalog.test.ts`
- `canvas-v2/src/templates/catalog/architecture.ts`
- `canvas-v2/src/templates/catalog/commerce.ts`
- `canvas-v2/src/templates/catalog/education.ts`
- `canvas-v2/src/templates/catalog/entertainment.ts`
- `canvas-v2/src/templates/catalog/game.ts`
- `canvas-v2/src/templates/catalog/marketing.ts`
- `canvas-v2/src/templates/catalog/media.ts`
- `canvas-v2/src/templates/catalog/index.ts`
- `canvas-v2/src/components/template-configurator-model.ts`
- `canvas-v2/src/components/template-configurator-model.test.ts`
- `canvas-v2/src/components/TemplateConfigurator.tsx`
- `canvas-v2/src/components/TemplateCatalog.tsx`
- `canvas-v2/src/components/template-catalog-markup.test.ts`

---

## Task 1: Freeze the corrected production semantics

**Files:**

- Modify: `docs/CANVAS-TEMPLATE-PACK-PLAN.md`
- Modify: `canvas-v2/src/templates/templates.test.ts`
- Modify: `canvas-v2/src/App.projection.test.ts`
- Modify: `canvas-v2/src/templates/builtin-templates.ts`

**Interfaces:**

- Consumes: current `CanvasTemplate`, `workflowNodeData()`, `toCanvasRunGraph()`.
- Produces: executable assertions that one image node means one request and video templates use `seconds`.

- [ ] Add a failing test named `does not claim unsupported count semantics in built-in templates` that serializes every built-in template and rejects a `count` config key.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates/templates.test.ts` and confirm the current three templates fail because two contain `count`.
- [ ] Add a failing `App.projection.test.ts` case that projects the current `xingmang-product-video` template and expects the run graph to contain `seconds: '5'`.
- [ ] Add a regression assertion that `{ durationSeconds: 8 }` is not treated as the production field.
- [ ] Run `npm run test:canvas -- canvas-v2/src/App.projection.test.ts` and confirm the new test exposes the current config/default mismatch.
- [ ] Rewrite the opening and shared rules in `docs/CANVAS-TEMPLATE-PACK-PLAN.md`: mark it as a product direction document, remove “可直接照抄”, explain explicit parallel nodes, `seconds`, Gallery limitations, and model-group compatibility.
- [ ] Correct the document’s factual counts: T04 original text 19 nodes/24 edges, T07 37/36 before count expansion, T16 missing three output edges, and T19 count contradiction.
- [ ] Remove `count` from the current quick-image and reference-edit template configs; update their descriptions to one request/one result.
- [ ] Replace the current product-video `durationSeconds:5` config with `seconds:'5'`.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates/templates.test.ts canvas-v2/src/App.projection.test.ts` and confirm all new contract tests pass.
- [ ] Commit documentation and green contract tests:

```bash
git add docs/CANVAS-TEMPLATE-PACK-PLAN.md canvas-v2/src/templates/templates.test.ts canvas-v2/src/App.projection.test.ts canvas-v2/src/templates/builtin-templates.ts
git commit -m "test(canvas): pin honest template execution semantics"
```

## Task 2: Extract and harden template validation

**Files:**

- Create: `canvas-v2/src/templates/validate-template.ts`
- Modify: `canvas-v2/src/templates/instantiate-template.ts`
- Modify: `canvas-v2/src/templates/templates.test.ts`
- Modify: `scripts/verify-canvas-provenance.test.cjs`
- Modify: `docs/canvas-third-party.json`

**Interfaces:**

- Consumes: `CanvasTemplate`, `builtinNodeRegistry`, registry node ports and dimensions.
- Produces: `validateCanvasTemplate(template, registry)` and a one-to-one provenance ledger gate.

- [ ] Extend the test fixture node types to use `builtinNodeRegistry` instead of a manually maintained `Set`.
- [ ] Add a failing test for variable paths `__proto__.polluted`, `constructor.prototype`, and `settings.prototype.value`; assert the global object remains unchanged.
- [ ] Add failing tests for duplicate edge IDs, duplicate variable IDs, unknown handles, reversed handles, media mismatch, and a second edge entering a `cardinality:'one'` port.
- [ ] Add failing tests for stale `definitionVersion`, incomplete `requiredNodeTypes`, select variables without options, duplicate select options, and a default outside options.
- [ ] Add a failing test that constructs two nodes whose registry-sized rectangles overlap.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates/templates.test.ts` and record the expected failures.
- [ ] Implement `validateCanvasTemplate()` in the new file. Keep all bounds explicit: ≤100 nodes, ≤400 edges, finite positions, unique bounded IDs, and credential-free config.
- [ ] Resolve source and target ports with `builtinNodeRegistry.port()` and reject invalid direction, media kind, cardinality, self-loop, and cycles.
- [ ] Reject path segments matching credentials or exactly `__proto__`, `prototype`, `constructor`; build nested objects with `Object.create(null)` or own-property checks.
- [ ] Validate that node rectangles do not overlap. Structural group containment is not used by built-in templates in this phase; the 32 px design gap is enforced later for new industry templates.
- [ ] Export validator result or throw messages in Chinese; keep tests focused on stable error fragments, not full sentences.
- [ ] Replace the private validator inside `instantiate-template.ts` with the new function.
- [ ] Add a Vitest assertion in `templates.test.ts` that reads `docs/canvas-third-party.json` with Node `fs` and compares the exact sorted template ID set to `builtinCanvasTemplates`; do not regex TypeScript object bodies.
- [ ] Extend `verify-canvas-provenance.test.cjs` to reject duplicate or non-`xingmang-original` template ledger records.
- [ ] Keep `docs/canvas-third-party.json.templates` at the current three IDs until Task 8 adds new templates.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates/templates.test.ts`.
- [ ] Run `node --test scripts/verify-canvas-provenance.test.cjs`.
- [ ] Commit:

```bash
git add canvas-v2/src/templates/validate-template.ts canvas-v2/src/templates/instantiate-template.ts canvas-v2/src/templates/templates.test.ts scripts/verify-canvas-provenance.test.cjs docs/canvas-third-party.json
git commit -m "fix(canvas): validate template graphs against the registry"
```

## Task 3: Normalize template node configuration for the production run graph

**Files:**

- Create: `canvas-v2/src/domain/workflow-node-config.ts`
- Create: `canvas-v2/src/domain/workflow-node-config.test.ts`
- Modify: `canvas-v2/src/App.tsx`
- Modify: `canvas-v2/src/domain/builtin-node-definitions.ts`
- Modify: `canvas-v2/src/templates/builtin-templates.ts`
- Modify: `canvas-v2/src/App.projection.test.ts`

**Interfaces:**

- Consumes: registry defaults, current image/video model IDs, `imageModelPresets`, `videoModelPresets`.
- Produces: `workflowNodeData()`, `operationDefaultsForTemplateNode()`, and a production-safe `seconds` projection.

- [ ] Move `workflowNodeData()` from `App.tsx` into `workflow-node-config.ts` without behavior changes; re-export from `App.tsx` temporarily if existing tests import it there.
- [ ] Run the current canvas tests and confirm the mechanical extraction is green before changing behavior.
- [ ] Add a failing test that `video-generate` defaults to top-level `seconds:'5'` and never places `durationSeconds` in settings.
- [ ] Add failing tests for model selection: image edit skips a configured generation-only Jimeng model; video selects only configured video models; no compatible model returns a structured unavailable result.
- [ ] Add failing tests that unsupported `quality` and `size` are dropped for a selected Grok image preset but preserved for `gpt-image-2`.
- [ ] Change `video-generate.defaultData` from `{ durationSeconds: 5 }` to `{ seconds: '5' }`.
- [ ] Implement `operationDefaultsForTemplateNode(type, imageModels, videoModels)` using capability predicates in `models.ts`; return `{ available, config, reason? }`.
- [ ] Keep template `model` as a preference only when it exists in the current group and supports the node operation; otherwise choose the first compatible configured model.
- [ ] Update `App.loadTemplate()` to merge registry defaults, capability-safe operation defaults, then non-model template fields; prevent a stale preferred model from overriding the resolved model.
- [ ] Confirm the Task 1 template configs remain free of `count` and `durationSeconds` after the helper extraction.
- [ ] Make the new default-field, capability-selection, and option-filtering tests pass.
- [ ] Run `npm run test:canvas -- canvas-v2/src/domain/workflow-node-config.test.ts canvas-v2/src/App.projection.test.ts canvas-v2/src/templates/templates.test.ts`.
- [ ] Commit:

```bash
git add canvas-v2/src/domain/workflow-node-config.ts canvas-v2/src/domain/workflow-node-config.test.ts canvas-v2/src/App.tsx canvas-v2/src/domain/builtin-node-definitions.ts canvas-v2/src/templates/builtin-templates.ts canvas-v2/src/App.projection.test.ts
git commit -m "fix(canvas): normalize template config for production runs"
```

## Task 4: Add industry metadata, catalog helpers, and derived request estimates

**Files:**

- Modify: `canvas-v2/src/templates/template-types.ts`
- Create: `canvas-v2/src/templates/template-catalog.ts`
- Create: `canvas-v2/src/templates/template-catalog.test.ts`
- Create: `canvas-v2/src/templates/catalog/index.ts`
- Modify: `canvas-v2/src/templates/builtin-templates.ts`

**Interfaces:**

- Consumes: validated `CanvasTemplate[]` and current configured models.
- Produces: industry grouping, search, compatibility result, and topology-derived request estimates.

- [ ] Add failing type-level/runtime fixtures for the seven stable industry IDs from the design spec.
- [ ] Add a failing estimate test with four `image-generate`, two `image-edit`, and one `video-generate`; expect `{ imageRequests:6, videoRequests:1, paidRequests:7 }`.
- [ ] Add a failing search test covering name, description, deliverable, industry label, and tags with `toLocaleLowerCase('zh-CN')`.
- [ ] Add a failing compatibility test: an edit template is unavailable when the image group only exposes Jimeng, and available when it exposes GPT Image or Grok edit models.
- [ ] Add a failing option-capability test: a three-size template is unavailable when the group only exposes an image model with `supportsSize:false`.
- [ ] Extend `CanvasTemplate` with `industry`, `deliverable`, optional `disclaimer`, optional `featured`, and operation requirements; requirements may demand `size` or `quality` support.
- [ ] Implement `estimateCanvasTemplate()` by counting paid node types; never parse description text.
- [ ] Implement `canvasTemplateCompatibility()` from template requirements, required options, and current group model lists.
- [ ] Implement stable industry labels and ordering in `template-catalog.ts`.
- [ ] Move the current three templates behind `catalog/index.ts`; `builtin-templates.ts` remains a compatibility re-export with a frozen array order.
- [ ] Assign current templates honest metadata and requirements.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates/template-catalog.test.ts canvas-v2/src/templates/templates.test.ts`.
- [ ] Commit:

```bash
git add canvas-v2/src/templates/template-types.ts canvas-v2/src/templates/template-catalog.ts canvas-v2/src/templates/template-catalog.test.ts canvas-v2/src/templates/catalog/index.ts canvas-v2/src/templates/builtin-templates.ts
git commit -m "feat(canvas): add an industry template catalog contract"
```

## Task 5: Make Gallery aggregate explicit parallel results

**Files:**

- Modify: `electron/canvas-node-executors.ts`
- Modify: `electron/canvas-node-executors.test.ts`
- Modify: `electron/canvas-run-engine.ts`
- Modify: `electron/canvas-run-engine.test.ts`
- Modify: `electron/canvas-run-service.ts`
- Modify: `electron/canvas-run-service.test.ts`
- Modify: `canvas-v2/src/runtime/run-projection.test.ts`

**Interfaces:**

- Consumes: `CanvasNodeInputs.images/videos/audios`, run candidate records, cache callbacks.
- Produces: all same-media Gallery inputs as candidates; flow nodes never restore a truncated single-candidate cache.

- [ ] Add a failing executor test with six image inputs and assert Gallery returns six ordered assets.
- [ ] Add tests for video-only and audio-only Gallery input; mixed media follows image → video → audio priority and returns the full chosen media family.
- [ ] Add a failing run-engine test with six upstream image nodes feeding one Gallery and assert the Gallery attempt contains six candidates.
- [ ] Add a failing cache regression test: a second run may cache the six paid upstream nodes, but Gallery must re-execute locally and still expose six candidates.
- [ ] Change the pass-through executor to return all assets from the selected input family.
- [ ] Add `isCanvasNodeCacheEligible(kind)` in the run engine or service and return false for `gallery`, `router`, and `output`; these nodes are local and cheap.
- [ ] Preserve caching for paid generation, prompt, and owned input nodes.
- [ ] Confirm downstream output still receives the first candidate in the current run; add a test so this limitation is explicit until a review-gate exists.
- [ ] Extend run projection test coverage so Gallery candidates appear in `candidateAssetIds` without duplicating IDs.
- [ ] Run `npx vitest run electron/canvas-node-executors.test.ts electron/canvas-run-engine.test.ts electron/canvas-run-service.test.ts canvas-v2/src/runtime/run-projection.test.ts`.
- [ ] Commit:

```bash
git add electron/canvas-node-executors.ts electron/canvas-node-executors.test.ts electron/canvas-run-engine.ts electron/canvas-run-engine.test.ts electron/canvas-run-service.ts electron/canvas-run-service.test.ts canvas-v2/src/runtime/run-projection.test.ts
git commit -m "feat(canvas): aggregate explicit parallel gallery results"
```

## Task 6: Build the template configuration model

**Files:**

- Create: `canvas-v2/src/components/template-configurator-model.ts`
- Create: `canvas-v2/src/components/template-configurator-model.test.ts`
- Modify: `canvas-v2/src/templates/instantiate-template.ts`

**Interfaces:**

- Consumes: `TemplateVariable[]`, local `CanvasAssetPage`, template compatibility.
- Produces: initial field state, validation errors, sanitized `values`, and draft/full insertion modes.

- [ ] Add failing tests that default text/select values populate field state and required fields start invalid only after submit or touch.
- [ ] Add failing tests that select values must belong to options.
- [ ] Add failing tests that asset values must be present in the local asset list or returned by the trusted host picker and match the 43-character ID format.
- [ ] Add a test that a URL, absolute path, `data:` URI, or arbitrary string cannot become an asset variable.
- [ ] Add a test that optional text may be omitted, but an asset connected to an executable branch must be required by template validation.
- [ ] Implement `createTemplateConfiguratorState(template)` and `validateTemplateConfiguratorState(template, state)` as pure functions.
- [ ] Return a `Readonly<Record<string, unknown>>` values object only when all required fields are valid.
- [ ] Keep full insertion on `instantiateTemplate(..., draft:false)` and skeleton insertion on `draft:true` with no values.
- [ ] Add an instantiate regression test proving full insertion binds text/select/assets and still remaps all IDs.
- [ ] Run `npm run test:canvas -- canvas-v2/src/components/template-configurator-model.test.ts canvas-v2/src/templates/templates.test.ts`.
- [ ] Commit:

```bash
git add canvas-v2/src/components/template-configurator-model.ts canvas-v2/src/components/template-configurator-model.test.ts canvas-v2/src/templates/instantiate-template.ts canvas-v2/src/templates/templates.test.ts
git commit -m "feat(canvas): validate template inputs before insertion"
```

## Task 7: Build the industry catalog and configurator UI

**Files:**

- Create: `canvas-v2/src/components/TemplateConfigurator.tsx`
- Create: `canvas-v2/src/components/TemplateCatalog.tsx`
- Create: `canvas-v2/src/components/template-catalog-markup.test.ts`
- Modify: `canvas-v2/src/components/NodeLibrary.tsx`
- Modify: `canvas-v2/src/components/QuickInsert.tsx`
- Modify: `canvas-v2/src/App.tsx`
- Modify: `canvas-v2/src/styles.css`

**Interfaces:**

- Consumes: catalog helpers, configurator model, current assets, configured image/video models.
- Produces: accessible industry browsing, compatibility/readiness display, and one-command template insertion.

- [ ] Add source/markup tests requiring `role="dialog"`, labelled close button, industry filter accessible name, request estimate label, disclaimer region, and disabled unavailable action.
- [ ] Add a failing App projection test that full insertion calls `instantiateTemplate` with values and `draft:false` while skeleton insertion uses `draft:true`.
- [ ] Implement `TemplateCatalog` with industry chips, query search, featured section, and cards showing deliverable, required inputs, derived image/video request counts, and compatibility.
- [ ] Use color swatches only; do not add remote thumbnails or unlicensed images.
- [ ] Implement `TemplateConfigurator` fields for `text`, `select`, and `asset`.
- [ ] For asset fields, show matching assets from the existing local asset page and an “导入本地素材” action that calls the existing trusted host picker/import flow.
- [ ] Keep focus inside the active dialog, restore focus to the opener on close, support Escape, and ensure every field has a visible label.
- [ ] Add primary “填写并插入” and secondary “先插入空白骨架” actions. Neither action starts a run.
- [ ] Refactor `App.loadTemplate()` into `insertTemplate(templateId, values?, draft)` and ensure one reducer command creates all nodes/edges.
- [ ] Change empty-canvas “从模板开始” to open the catalog instead of loading index 0 immediately.
- [ ] Change NodeLibrary template rows to open the catalog/configurator detail instead of immediate insertion.
- [ ] Keep QuickInsert fast: selecting a template opens its configurator; it must not create nodes before confirmation.
- [ ] Add responsive styles for 960×620 and keyboard focus; reuse current surfaces, tokens, radii, and accent colors.
- [ ] Run `npm run test:canvas -- canvas-v2/src/components/template-catalog-markup.test.ts canvas-v2/src/App.projection.test.ts`.
- [ ] Run `npm run canvas:prepare`.
- [ ] Commit:

```bash
git add canvas-v2/src/components/TemplateConfigurator.tsx canvas-v2/src/components/TemplateCatalog.tsx canvas-v2/src/components/template-catalog-markup.test.ts canvas-v2/src/components/NodeLibrary.tsx canvas-v2/src/components/QuickInsert.tsx canvas-v2/src/App.tsx canvas-v2/src/styles.css
git commit -m "feat(canvas): add the industry template storefront"
```

## Task 8: Ship Batch 1 templates and prompt presets

**Files:**

- Create: `canvas-v2/src/templates/catalog/commerce.ts`
- Create: `canvas-v2/src/templates/catalog/architecture.ts`
- Create: `canvas-v2/src/templates/catalog/education.ts`
- Modify: `canvas-v2/src/templates/catalog/index.ts`
- Modify: `canvas-v2/src/library/prompt-presets.ts`
- Modify: `canvas-v2/src/library/prompt-presets.test.ts`
- Modify: `canvas-v2/src/templates/templates.test.ts`
- Modify: `docs/canvas-third-party.json`

**Interfaces:**

- Consumes: validated catalog contract, explicit parallel Gallery, current image edit/generate models.
- Produces: T09, T15, T12, T06 with exact request counts 4, 4, 12, 4.

- [ ] Add expected IDs and counts to a failing catalog test:

```text
xingmang-ec-white-bg          image 4, video 0
xingmang-media-xhs-cover      image 4, video 0
xingmang-home-rough-6         image 12, video 0
xingmang-comic-lineart-color  image 4, video 0
```

- [ ] Add a failing layout assertion that every new template has no registry-sized rectangle collision and remains within ±10,000 coordinate bounds.
- [ ] Implement T09 as one required image asset + one default complete prompt + four parallel `image-edit` nodes + one Gallery. Do not connect Gallery to output as an implied manual gate.
- [ ] Implement T15 as one required topic prompt + four parallel `image-generate` nodes + one Gallery. Name and disclaimer must say it produces background candidates, not finished typography.
- [ ] Implement T12 as one required room image + six complete default style prompts + two edits per style + one Gallery. Use row spacing ≥420 px and column spacing based on registry widths.
- [ ] Implement T06 as one required line-art image + one complete default style prompt + four edits + one Gallery.
- [ ] Leave image models unpinned or as capability-safe preferences; all four templates require an edit-capable image model except T15.
- [ ] Add disclaimers: T09 result must be checked against the real product; T12 is concept visualization, not construction documentation; T15 has no text layout guarantee.
- [ ] Add 8–12 Xingmang-original prompt presets supporting white background, product scenes, six interior styles, line-art coloring, and social cover backgrounds.
- [ ] Add prompt preset tests for unique IDs, bounded text, provenance, and search tags.
- [ ] Add all four template IDs to `docs/canvas-third-party.json.templates` with `xingmang-original` provenance.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates canvas-v2/src/library/prompt-presets.test.ts`.
- [ ] Run `node --test scripts/verify-canvas-provenance.test.cjs`.
- [ ] Commit:

```bash
git add canvas-v2/src/templates/catalog/commerce.ts canvas-v2/src/templates/catalog/architecture.ts canvas-v2/src/templates/catalog/education.ts canvas-v2/src/templates/catalog/index.ts canvas-v2/src/library/prompt-presets.ts canvas-v2/src/library/prompt-presets.test.ts canvas-v2/src/templates/templates.test.ts docs/canvas-third-party.json
git commit -m "feat(canvas): ship the first four industry templates"
```

## Task 9: Extend preflight and visual smoke for template truthfulness

**Files:**

- Modify: `canvas-v2/src/runtime/run-preflight.ts`
- Modify: `canvas-v2/src/runtime/run-preflight.test.ts`
- Modify: `canvas-v2/src/components/RunPreflight.tsx`
- Modify: `e2e/canvas-editor-smoke.mjs`

**Interfaces:**

- Consumes: selected run graph, cache set, paid node kinds.
- Produces: separate image/video request counts and an Electron UI proof that templates never auto-run.

- [ ] Add failing preflight tests for a graph with 12 edit nodes and assert `imageRequestCount:12`, `videoRequestCount:0`, `paidRequestCount:12`.
- [ ] Add a cache-helper test where the caller explicitly supplies four cached edit node IDs; expect the computed new paid requests to drop from 12 to 8. The production UI does not pre-query cache and therefore continues to display the safe maximum 12.
- [ ] Extend `CanvasRunPreflight` with `imageRequestCount` and `videoRequestCount`; keep `paidRequestCount` for compatibility.
- [ ] Update `RunPreflight` to show “图片请求 / 视频请求 / 缓存” without displaying money or quota estimates.
- [ ] In the Electron smoke fixture, open the template catalog, filter to 家装, choose T12, bind the fixture asset, insert it, and assert no `startRun` call occurred.
- [ ] Assert the inserted graph contains 12 image-edit nodes and the preflight shows 12 image requests.
- [ ] Cancel at preflight and assert `startRun` call count remains zero.
- [ ] Add screenshots for compact/laptop/desktop/4k catalog and the T12 fitted graph, using the existing artifact directory.
- [ ] Run `npm run canvas:prepare`.
- [ ] Run `npm run test:canvas:visual`.
- [ ] Commit:

```bash
git add canvas-v2/src/runtime/run-preflight.ts canvas-v2/src/runtime/run-preflight.test.ts canvas-v2/src/components/RunPreflight.tsx e2e/canvas-editor-smoke.mjs
git commit -m "test(canvas): verify template costs and storefront flows"
```

## Task 10: Ship Batch 2 low-risk templates

**Files:**

- Create: `canvas-v2/src/templates/catalog/entertainment.ts`
- Create: `canvas-v2/src/templates/catalog/game.ts`
- Create: `canvas-v2/src/templates/catalog/marketing.ts`
- Modify: `canvas-v2/src/templates/catalog/commerce.ts`
- Modify: `canvas-v2/src/templates/catalog/index.ts`
- Modify: `canvas-v2/src/templates/templates.test.ts`
- Modify: `docs/canvas-third-party.json`

**Interfaces:**

- Consumes: Batch 0 infrastructure and explicit parallel requests.
- Produces: T03, T11, T17, T18, T20.

- [ ] Add failing expected topology tests for:

```text
xingmang-drama-shot-video  image 0, video 1, seconds 8
xingmang-ec-size-trio      image 6, video 0
xingmang-game-icon-set     image 4, video 0
xingmang-game-variant      image 4, video 0
xingmang-film-animatic     image 0, video 1, seconds 5
```

- [ ] Implement T03 with required frame and motion variables; connect to a video node using `seconds:'8'` and `720x1280`.
- [ ] Implement T11 with required product and full sell-point prompt; create two edits each for square, vertical, and wide outputs; resolve unsupported sizes by model capability.
- [ ] Implement T17 with required style anchor and item prompt; create four edits; disclaimer says transparent background is not guaranteed.
- [ ] Implement T18 with two prompt nodes feeding `in:text`: a fixed identity-preservation prompt and a required user difference prompt; create four edits.
- [ ] Implement T20 with required frame and complete camera prompt; use `seconds:'5'`, `1280x720`, and no tail-frame promise.
- [ ] Ensure every asset input on an executable branch is required.
- [ ] Add the five IDs to the provenance ledger.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates`.
- [ ] Run `node --test scripts/verify-canvas-provenance.test.cjs`.
- [ ] Commit:

```bash
git add canvas-v2/src/templates/catalog/entertainment.ts canvas-v2/src/templates/catalog/game.ts canvas-v2/src/templates/catalog/marketing.ts canvas-v2/src/templates/catalog/commerce.ts canvas-v2/src/templates/catalog/index.ts canvas-v2/src/templates/templates.test.ts docs/canvas-third-party.json
git commit -m "feat(canvas): add low-risk industry workflow templates"
```

## Task 11: Ship Batch 3 topology-corrected templates

**Files:**

- Modify: `canvas-v2/src/templates/catalog/entertainment.ts`
- Modify: `canvas-v2/src/templates/catalog/education.ts`
- Modify: `canvas-v2/src/templates/catalog/commerce.ts`
- Modify: `canvas-v2/src/templates/catalog/architecture.ts`
- Create: `canvas-v2/src/templates/catalog/media.ts`
- Modify: `canvas-v2/src/templates/catalog/marketing.ts`
- Modify: `canvas-v2/src/templates/catalog/index.ts`
- Modify: `canvas-v2/src/templates/templates.test.ts`
- Modify: `docs/canvas-third-party.json`

**Interfaces:**

- Consumes: full configurator, Gallery aggregation, capability-safe model resolution.
- Produces: T02, T08, T10, T13, T14, T16, T19.

- [ ] Add failing expected topology tests:

```text
xingmang-drama-shot-frame   image 4, video 0
xingmang-edu-courseware-4   image 8, video 0
xingmang-ec-scene-3         image 6, video 0
xingmang-arch-mass-render   image 4, video 0
xingmang-arch-renewal       image 4, video 0
xingmang-media-broll-3      image 3, video 3, seconds 6
xingmang-ad-ab-pair         image 2, video 2, seconds 5
```

- [ ] Implement T02 with both character and scene assets required. If product wants single-reference mode, add a separate future template instead of an optional connected input.
- [ ] Implement T08 with four complete prompt variables/defaults and two generate nodes per prompt; do not rely on substring replacement.
- [ ] Implement T10 with one required product image, three complete default scene prompts, and two edits per scene.
- [ ] Implement T13 as the four-candidate concept render stage only. Rename deliverable to avoid promising same-run manual refinement.
- [ ] Implement T14 with one text variable containing the complete renovation prompt, four edits, and an unconnected note containing review guidance. Do not keep the unresolved select-plus-extra design.
- [ ] Implement T16 with three complete beat prompts; each branch has one image, one `seconds:'6'` video, and a completed video-to-output edge.
- [ ] Implement T19 with A/B prompts; each branch has one image, one `seconds:'5'` video, and a completed output edge.
- [ ] Add all seven IDs to the provenance ledger.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates`.
- [ ] Run `npm run canvas:prepare`.
- [ ] Commit:

```bash
git add canvas-v2/src/templates/catalog canvas-v2/src/templates/templates.test.ts docs/canvas-third-party.json
git commit -m "feat(canvas): add topology-corrected industry templates"
```

## Task 12: Ship Batch 4 large production skeletons

**Files:**

- Modify: `canvas-v2/src/templates/catalog/entertainment.ts`
- Modify: `canvas-v2/src/templates/catalog/education.ts`
- Modify: `canvas-v2/src/templates/catalog/index.ts`
- Modify: `canvas-v2/src/templates/templates.test.ts`
- Modify: `e2e/canvas-editor-smoke.mjs`
- Modify: `docs/canvas-third-party.json`

**Interfaces:**

- Consumes: validated non-overlapping layouts, configurator, explicit requests, Gallery aggregation.
- Produces: T01 revised, T04, T05, T07.

**Entry gate:** Batch 1 has completed one real-user trial round. Trial notes confirm that explicit request counts are understood and that the largest graph remains navigable. This is a product release gate, not an automated test.

- [ ] Add failing topology and limit tests:

```text
xingmang-drama-character-sheet  image 4, video 0
xingmang-drama-episode-6        image 24, video 6
xingmang-comic-strip-6          image 24, video 0
xingmang-picturebook-12         image 24, video 0
```

- [ ] Implement revised T01 as four parallel character-sheet candidates ending at Gallery. Do not include same-run turn-view refinement.
- [ ] Implement T04 with one required character asset, six required/default-complete shot prompts, four edits and one video per shot. Mark one deterministic edit per shot as primary and connect only that edit to video; send all four edits to the shot Gallery without claiming an in-run manual choice.
- [ ] Implement T05 with one required character asset, six required/default-complete panel prompts, four edits and one Gallery per panel. Disclaimer says long-strip composition and lettering happen outside Xingmang.
- [ ] Implement T07 with one required hero image, twelve required/default-complete page prompts, two edits and one Gallery per page. Disclaimer says pagination, typography, print color and TTS are external steps.
- [ ] Lay out large templates by registry dimensions, with branch lanes separated by at least 32 px; avoid the original fixed 220 px row spacing.
- [ ] Add visual smoke steps that insert T04 and T07, fit the graph, focus one branch, and prove no overlap at compact and desktop viewports.
- [ ] Add all four IDs to the provenance ledger.
- [ ] Run `npm run test:canvas -- canvas-v2/src/templates`.
- [ ] Run `npm run canvas:prepare`.
- [ ] Run `npm run test:canvas:visual`.
- [ ] Commit:

```bash
git add canvas-v2/src/templates/catalog canvas-v2/src/templates/templates.test.ts e2e/canvas-editor-smoke.mjs docs/canvas-third-party.json
git commit -m "feat(canvas): add large industry production skeletons"
```

## Task 13: Final documentation, security, and cross-platform verification

**Files:**

- Modify: `docs/CANVAS-TEMPLATE-PACK-PLAN.md`
- Modify: `docs/CANVAS-THIRD-PARTY.md`
- Modify: `CLAUDE.md` only if documented channel counts or commands remain stale
- Modify: `.github/workflows/quality.yml` only if `test:canvas` is still absent from required jobs

**Interfaces:**

- Consumes: all 23 built-in templates, final test commands, provenance ledger.
- Produces: accurate docs and release evidence; no source behavior change.

- [ ] Update the template plan table with final node/edge/request counts generated by tests; do not hand-copy stale numbers.
- [ ] Document that Gallery aggregates results but is not a same-run review gate.
- [ ] Document that cost UI shows maximum requests, not guaranteed quota or money.
- [ ] Document every template disclaimer and the external finishing tool boundary.
- [ ] Update `CANVAS-THIRD-PARTY.md` to say all new templates and prompt presets are Xingmang-original and contain no third-party assets.
- [ ] Count `canvasHostChannels` from code and update `CLAUDE.md` only if it still claims 27.
- [ ] Ensure Windows and macOS quality jobs both exercise `npm run test:canvas`; add the script to the workflow if the final workflow still only runs it on one platform.
- [ ] Run `npm ci` on a clean dependency state.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test:canvas`.
- [ ] Run `npm test`.
- [ ] Run `npm run canvas:prepare`.
- [ ] Run `npm run test:canvas:visual`.
- [ ] Run `npm run test:windows` on Windows CI or a Windows runner.
- [ ] Run `npm run test:mac:dev-origin` on macOS.
- [ ] Run `npm run audit:ci`.
- [ ] Run `npm audit --omit=dev --audit-level=low --registry=https://registry.npmjs.org/`.
- [ ] Run `git diff --check`.
- [ ] Inspect the built renderer and confirm `scripts/verify-canvas-renderer-boundary.test.cjs` still passes.
- [ ] Open the real Electron development window and manually verify catalog, configurator, Batch 1 insertion, preflight, cancel, run, candidate adoption, save, reopen, export, and import.
- [ ] Confirm no test or manual fixture contacted production unless the run was explicitly designated as the separate real-relay smoke.
- [ ] Commit docs/workflow updates:

```bash
git add docs/CANVAS-TEMPLATE-PACK-PLAN.md docs/CANVAS-THIRD-PARTY.md CLAUDE.md .github/workflows/quality.yml
git commit -m "docs(canvas): finalize the industry template rollout"
```

---

## Final Acceptance Checklist

- [ ] `builtinCanvasTemplates` has 23 unique IDs: 3 legacy-compatible templates + 20 industry templates.
- [ ] The provenance ledger contains exactly the same 23 IDs.
- [ ] No template config contains `count` or `durationSeconds`.
- [ ] Every video node stores `seconds` as an integer string between 1 and 15.
- [ ] Every paid request count displayed by the UI equals the selected paid-node maximum; runtime cache may only reduce the actual submissions.
- [ ] Every connected asset input is required and resolves to a trusted local asset ID.
- [ ] Every template passes registry type/version/port/cardinality/DAG/layout validation.
- [ ] No template auto-runs or submits a paid request before preflight confirmation.
- [ ] Gallery shows all explicit parallel upstream assets and is never described as a review gate.
- [ ] Model-incompatible templates are visibly unavailable before run.
- [ ] T12, T04, T07 have no initial node overlap at supported viewports.
- [ ] No third-party image, screenshot, template wording, workflow or prompt entered the repository.
- [ ] Renderer source and build remain credential-free and relay-isolated.
- [ ] Full unit, Electron, node, visual, security, audit, Windows, and macOS gates pass.
