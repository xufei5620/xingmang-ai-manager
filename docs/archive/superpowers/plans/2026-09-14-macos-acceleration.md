# macOS Acceleration Implementation Plan

> 后续授权：用户已明确要求升至 0.2.4、提交 PR、合并 main，再本地打包发布 macOS arm64/x64。本文此前“仅本地/不提交/不打包”描述保留作为该阶段记录，本次发布以新授权为准。

> **For agentic workers:** Use subagent-driven-development for isolated tasks and review. User approved continuous local implementation; do not ask again between tasks.

**Goal:** Make existing local-device acceleration run on macOS arm64/x64 with safe proxy recovery and private bundle resources.

**Architecture:** Reuse the TypeScript account/ledger/runtime and detached worker. A narrow native SystemConfiguration helper owns Mac proxy configuration, authorization, durable recovery and process lock. Bundle resources select the target platform/architecture and preserve integrity after signing.

**Tech Stack:** Electron 43, TypeScript 5.7, Swift/SystemConfiguration, Node test/Vitest, electron-builder.

## Global Constraints

- Source baseline ac7650b; branch codex/macos-acceleration; no commits, PR, application packaging or publication. User explicitly clarified this boundary.
- macOS >=13, arm64/x64; preserve Windows manifest version 1 compatibility.
- Local account trial remains 1200 seconds; only system-proxy mode.
- Private YAML and credentials never enter Git, renderer IPC, tests, diagnostics or plan files.
- Native helper must never accept arbitrary commands or weaken security settings. All process launches use argv and shell:false.
- Use existing safe/bounded file handling. Hash and architecture validation fail closed.

### Task 1: Mac proxy lifecycle

**Files:** Create native/macos-system-proxy.swift, scripts/build-macos-system-proxy.cjs, electron/platform/macos-system-proxy.ts and focused tests. Parent owns package/builder integration.

**Interface:** `createMacosSystemProxy({journalPath, helperPath?, ...testDependencies})` returns `{enable(port):Promise<void>, restore():Promise<void>, recover():Promise<void>, dispose?():Promise<void>}`. Native helper artifacts: `dist-native/macos-system-proxy-arm64` and `dist-native/macos-system-proxy-x64`. Helper path is chosen by trusted parent code, never renderer input.

- [x] Write tests where restore preserves PAC and unrelated fields, refuses a live competing owner, recovers a dead owner, retains recovery after failed writes and protects externally changed endpoints. Run focused tests to establish red.
- [x] Implement native JSON RPC and SystemConfiguration transaction. Acquire a process lock before journal transitions; full proxy dictionary snapshots; persist before apply; fail closed on authorization denial; compare expected state before restore; keep unrelated services/fields. Restrict service selection to enabled physical interfaces.
- [x] Handle stdin EOF and termination by restore; keep journal if restoration cannot be confirmed. Support an isolated test preferences store so native tests never change host networking.
- [x] Implement bounded TypeScript transport, helper path validation, fixed Chinese errors, process-exit and timeout cleanup. Compile both targets with `/usr/bin/xcrun swiftc -target <arch>-apple-macosx13.0`.
- [x] Run native fixture tests and adapter tests; write review report with red/green evidence.

### Task 2: Architecture-specific resources

**Files:** scripts/stage-acceleration-bundle.cjs and tests; electron/acceleration-bundled-config.ts and tests; electron-builder.config.cjs; optional pure binary/manifest helpers.

- [x] Add red tests: Darwin arm64 and x64 Mach-O accepted; PE rejected for Mac; wrong CPU, changed hash, malformed platform and Windows regressions.
- [x] Add explicit `--platform darwin --arch arm64|x64` staging and version 2 manifest; preserve default Windows staging. Verify official compressed-asset digest separately from staged executable digest.
- [x] Resolve bundle resources against builder target architecture; include helper separately and account for signing effects before fixing final metadata. Runtime rejects incompatible/mutated resources.
- [x] Run staging and bundled config tests with fixture resources. No release staging or application packaging in this task.

### Task 3: Worker/runtime integration

**Files:** electron/acceleration-development-host.ts, acceleration-development-worker.ts, acceleration-worker-entry.ts and tests, main.ts, package.json, build helpers.

- [x] Add red tests for Darwin dev config and packaged worker, rejecting unsupported platforms and no-parent worker invocations.
- [x] Select Mac proxy in Darwin worker; wire trusted native helper path and recovery, retain Windows implementation. Add native prepare step to Mac dev/compile flow only. Preserve Electron fuses and private profile pin checks.
- [x] Verify resource hash and core launch on Darwin, packaged helper headless behavior, cancellation and account/time cleanup.

### Task 4: Verification and delivery

**Files:** docs/GLOBAL-ACCELERATION.md, docs/MACOS_DEVELOPMENT.md, docs/RELEASING.md, local ignored evidence.

- [x] Run typecheck and relevant tests; compare against recorded clean baseline. Run full required suites once stable.
- [x] Run native isolated preferences lifecycle and real no-system-proxy node connectivity; perform system proxy before/after recovery checks only with user-authorized scope and standard OS authorization.
- [x] Compile native helper for local verification and inspect target architectures. Do not create app candidates, installers or release artifacts. Record what future package validation remains.
- [x] Independent code review, resolve findings, record truthful limitations and final status.

## 实际验收范围

见 `docs/MACOS_ACCELERATION_VALIDATION.md`。真实内核连接通过；系统代理写入使用隔离 fixture 验证，本机系统配置未切换。用户禁止的安装包/PR/发布未执行。
