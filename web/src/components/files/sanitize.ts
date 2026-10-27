/**
 * Nothing in a file is ever run (docs/ui-design.md, "Speed and safety"): SVG is cleaned before it is drawn. Scripts,
 * foreign objects, animation that can set attributes, event handlers and links out of the drawing are removed;
 * styles and text stay so the drawing looks as made and its words can be selected.
 */
import DOMPurify from 'dompurify'

// attribute values may be anything without a scheme ("red", "4", "url(#g)"), or an inline picture; never http:, javascript: …
const NO_SCHEME = /^(?:data:image\/(?:png|jpe?g|gif|webp);|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
const LINK_ATTRS = new Set(['href', 'xlink:href'])
// references stay inside the drawing (#id) or are inline pictures
const OK_LINK = /^(#|data:image\/(png|jpe?g|gif|webp);)/i

let purifier: ReturnType<typeof DOMPurify> | null = null
function get() {
  if (purifier) return purifier
  const p = DOMPurify(window)
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    if (LINK_ATTRS.has(data.attrName) && !OK_LINK.test(data.attrValue.trim())) data.keepAttr = false
  })
  purifier = p
  return p
}

/** `keepStyle`: only for SVG this app generated from a library's own stylesheet (WaveDrom's skin), never a file's. */
export function sanitizeSvg(svg: string, o: { keepStyle?: boolean } = {}): string {
  const out = String(
    get().sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // <use> repeats a shape from this drawing; the hook above drops any reference that leaves it
      ADD_TAGS: ['use'],
      FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object', 'animate', 'set', 'animateMotion', 'animateTransform', 'a', ...(o.keepStyle ? [] : ['style'])],
      ALLOWED_URI_REGEXP: NO_SCHEME,
      KEEP_CONTENT: true,
    }),
  )
  // the purifier drops namespace declarations; an SVG drawn as an image needs xlink's back to be well formed
  return /xlink:/.test(out) && !/xmlns:xlink=/.test(out) ? out.replace(/<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"') : out
}

/** A cleaned SVG as an image address (for comparing drawings like images). */
export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(svg))}`
