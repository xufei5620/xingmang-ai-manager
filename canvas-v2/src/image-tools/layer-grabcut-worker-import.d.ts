declare module '*?worker' {
  const WorkerConstructor: { new (options?: WorkerOptions): Worker }
  export default WorkerConstructor
}

declare module '*opencv-grabcut-2b3586b4fe00ea68120073e8902655b27997b6a61951074fd78a2df1ff74d6a5.js' {
  export default function createLayerGrabCutRuntime(): unknown
}
