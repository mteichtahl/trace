/**
 * The criteria SHACL shapes back (docs/ontology.md "Gates as SHACL shapes"): one file per criterion,
 * ontology/shapes/<criterion>.ttl, run by shape.check (src/tools/shape/tools.ts). The list is here as well as in the
 * folder because the specialists' prompt names them and the harness bundle (CommonJS, no import.meta) cannot find the
 * folder; test/ontology/shapes.test.ts holds the two the same.
 */
export const SHAPED_CRITERIA: readonly string[] = ['architect.mapped', 'architect.stock', 'capture.stock', 'fabricate.order.stock', 'layout.fit', 'signoff.bom']

/** The criteria that have a shape. */
export const shapedCriteria = (): string[] => [...SHAPED_CRITERIA].sort()
