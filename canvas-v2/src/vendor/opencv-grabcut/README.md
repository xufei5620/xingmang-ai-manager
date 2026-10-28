# OpenCV GrabCut runtime

This is a custom, minimal build of the official **OpenCV 4.13.0** source using
**Emscripten 4.0.20** and **CMake 3.31.6**. It uses the unchanged upstream GrabCut
implementation. It is not the npm `@techstark/opencv-js` prebuilt artifact.

The exact distributed bytes, original archives, checksums, build settings and
license digest are recorded in `manifest.json`. The full license notices are
both in `LICENSES.txt` and embedded at the top of the distributed JavaScript.
GrabCut and GCGraph retain their Intel license notice in addition to OpenCV's
Apache-2.0 license; the Emscripten runtime license is retained too.

## Runtime boundary

- The format is an ES module exporting an async `default` factory.
- `WASM=0` uses Emscripten's wasm2js output. Its local `WebAssembly` compatibility
  object is ordinary compiled JavaScript, not the browser's WebAssembly compiler.
- `DYNAMIC_EXECUTION=0` disables string code generation. No `unsafe-eval` or
  `wasm-unsafe-eval` policy is needed. PThreads are disabled.
- Runtime code is loaded only on explicit local selection work, inside a module
  Worker from the same origin. No CDN, remote module URL or external WASM file is
  used. No model service, credential or image upload is involved.
- The Worker is terminated at job completion/cancellation. Its heap starts at
  32 MiB and is bounded at 512 MiB; the application's stricter pixel/timeout
  limits remain authoritative. Peak process memory can exceed the heap size.
- Only `setRNGSeed` and `grabCut` are added to upstream's core Mat/Rect bindings.
  `getBuildInformation` is already present in upstream's core bindings and must
  not also be listed in the function whitelist.

## Building

Build outside the tracked source tree. Download the exact URLs recorded in
`manifest.json`, verify their full hashes, and extract them into a work directory:

```
workdir/
  opencv-4.13.0/
  emsdk-4.0.20/upstream/       # toolchain archive's install/ directory
  cmake-3.31.6/cmake/data/bin/
  grabcut-whitelist.py        # copy the file beside this README
```

The original upstream archives are retained separately as release evidence.
`bounded-memory.patch` documents the only source customization: changing
upstream's 128 MiB / 1 GiB linker memory defaults to 32 MiB / 512 MiB. The
algorithm sources are unmodified. The builder applies this change explicitly,
uses the official build configuration, and compiles with at most two jobs.

```
python3 canvas-kernel/src/vendor/opencv-grabcut/build-grabcut.py --workdir /absolute/workdir --node /absolute/node
```

The raw output is `workdir/asmjs-build/bin/opencv_js.js`. Do not run OpenCV's UMD
wrapper target: production and Vite development both use module Workers.
Prefix the raw output with `/*!\n`, the exact `LICENSES.txt` bytes and `\n*/\n`.
The resulting SHA-256 must become both the filename and the pinned manifest
value. Save the artifact under `canvas-kernel/src/vendor/opencv-grabcut/runtime/`, update `sourcePath` in
the manifest and update the Worker's literal static import. Never change the bytes
behind an existing content-addressed source filename.

Build diagnostics can vary between host/toolchain paths; an independent rebuild
is not claimed to be byte-identical. Every release uses and verifies its reviewed
artifact digest. Runtime regression tests execute the actual pinned artifact
with JavaScript string generation and native WebAssembly disabled.

## Release retention

The reviewed source artifact is statically imported only by the on-demand module
Worker. Both Vite modes bundle it into `_next/static/chunks/` with a build hash;
there is no separate public runtime URL or dynamic import. Vite may transform the
compiled source, so the final Worker has its own release inventory digest.

The existing retention boundary covers these hashed Worker chunks and keeps
exactly the preceding release's native assets. It does not recursively retain
earlier generations. Both build manifests and deployed HTTP responses must be
checked for a complete Worker dependency closure. The actual Worker from each
build must also execute under strict CSP before a release is accepted.
