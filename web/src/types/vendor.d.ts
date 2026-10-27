/** Types for the few untyped packages the file viewers load (each lazily). */

declare module 'occt-import-js' {
  interface OcctMesh {
    name?: string
    color?: [number, number, number]
    attributes: { position: { array: number[] }; normal?: { array: number[] } }
    index: { array: number[] }
  }
  interface Occt {
    ReadStepFile(content: Uint8Array, params: unknown): { success: boolean; meshes: OcctMesh[] }
  }
  const init: (o?: { locateFile?: (name: string) => string }) => Promise<Occt>
  export default init
}

declare module 'wavedrom' {
  type Onml = unknown[]
  const wavedrom: {
    renderAny(index: number, source: object, skin: unknown): Onml
    waveSkin: unknown
    onml: { stringify(tree: Onml): string }
  }
  export default wavedrom
}

declare module '@/vendor/kicanvas/kicanvas.js'
