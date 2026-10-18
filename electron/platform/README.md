# Platform zoom

`zoom.ts` names the 1280 DIP algorithm (automatic factor clamped to
0.9-1.25, final factor to 0.85-1.25 since UI v4.0, plus the
auto/90/100/110 preference) for this layer, but delegates to `calculateUiZoom`
in `window-preferences.ts`, which is the product's only zoom formula. Two
appliers write the window zoom on the same events, so a second copy of the
clamp here would silently decide the result by listener registration order.

Renderer code gets platform support from `platform:get-capabilities` in
`ipc.ts`, which reads `platform-capabilities.ts`; it never inspects process
globals or guesses platform support from a user-agent string.
