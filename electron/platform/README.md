# Platform facade

`facade.ts` exposes a typed, read-only snapshot for the v2 renderer adapter.
The main process supplies `process.platform`, `process.arch`, and native probes
at the integration point; renderer components receive the resulting snapshot
and never inspect process globals or guess platform support.

`zoom.ts` is the v3.1.1 1280 DIP algorithm (0.7-1.25 clamp plus the
auto/90/100/110 preference). `registry.ts` contains platform-only display
facts used by the adapter. Native capabilities default to false until a real
probe confirms them, so unavailable tray, notification, secure storage, deep
link, or startup support remains visible as an application fallback.

This facade does not add signing, certificate, publisher, or release behavior.
