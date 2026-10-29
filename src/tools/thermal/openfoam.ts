/**
 * The airflow path (thermal.board solver=cfd): conjugate heat transfer with OpenFOAM (ESI-OpenCFD release v2412,
 * https://www.openfoam.com, whose chtMultiRegionSimpleFoam (steady) and chtMultiRegionFoam (transient) solve the
 * air and the solids together). (The openfoam.org releases from v11 replaced those two solvers with foamMultiRun
 * and solver modules, so the case below is written for the ESI line.)
 *
 * The case is written by trace, in TypeScript, into the job's scratch space (nothing is kept in the repository):
 *
 *   geometry     a fluid box (blockMesh) around the board, or an enclosure STL that bounds the air; the board and
 *                each powered part as solid boxes (searchableBox), turned into cell zones by snappyHexMesh and into
 *                regions by splitMeshRegions -cellZones
 *   solids       heSolidThermo, isotropic: the board takes its in-plane effective conductivity (copper coverage
 *                weighted, as the 2.5D model), which over-states through-thickness conduction; parts are mould
 *                compound; each part's power is a scalarSemiImplicitSource on h in its own region
 *   air          heRhoThermo, perfect gas (or Boussinesq), constant transport, gravity; laminar for natural
 *                convection, k-omega SST for forced flow; radiation by fvDOM or P1 with the cited emissivities
 *                (boundaryRadiationProperties)
 *   boundaries   open faces (prghTotalPressure / inletOutlet at ambient) for natural convection; an inlet (fixed
 *                flow: flowRateInletVelocity, or a fan curve: fanPressure, pressure rise against volumetric flow)
 *                and an outlet for forced flow; vents as open patches of the enclosure
 *   coupling     turbulentTemperatureRadCoupledMixed on every region interface
 *   output       residuals (solverInfo), probes of T and U at named points, per-region min/max and mean T, the
 *                wall heat flux on every interface and the enthalpy flux through every open boundary (for the
 *                energy balance), foamToVTK of the last time
 *
 * Limits, stated in the tool too: the mesh is only as good as the geometry (boxes for parts, an STL enclosure as
 * given); fan curves are idealised (no swirl, no blade model, uniform over the inlet); laminar is assumed for
 * natural convection and k-omega SST for forced flow, with wall functions; runs take minutes to hours, so they go to
 * the CPU queue by default. No CFD run was made where this code was written (the sandbox could not install
 * OpenFOAM): the generated dictionaries are unit-tested, and the real-run test is skipped without the solver.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { scratchDir } from '../../core/store.js'
import { type Backend, backendFor, runJob } from '../../gpu/jobs.js'
import { churchillChu } from './validation.js'
import { MOLD } from './materials.js'

export const OPENFOAM_RELEASE = 'ESI OpenFOAM v2412 (Debian package openfoam2412 2412.260127-1, noble/amd64)'

// ------------------------------------------------------------------ dictionaries

export type FoamValue = string | number | boolean | FoamValue[] | { [k: string]: FoamValue } | Raw
export class Raw { constructor(readonly text: string) {} }
export const raw = (t: string): Raw => new Raw(t)

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : Number(v.toPrecision(8)).toString())

function value(v: FoamValue, indent: string): string {
  if (v instanceof Raw) return v.text
  if (typeof v === 'number') return fmt(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return `(${v.map((x) => value(x, indent)).join(' ')})`
  return `\n${indent}{\n${body(v, `${indent}    `)}${indent}}`
}

function body(d: { [k: string]: FoamValue }, indent = ''): string {
  return Object.entries(d).map(([k, v]) => {
    if (k.startsWith('#')) return `${indent}${k} ${value(v, indent)}\n`
    const key = /^[A-Za-z_][\w.:]*$/.test(k) ? k : `"${k}"`
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Raw)) return `${indent}${key}${value(v, indent)}\n`
    return `${indent}${key.padEnd(16)} ${value(v, indent)};\n`
  }).join('')
}

/** An OpenFOAM dictionary file: the FoamFile header, then the entries. */
export function foamFile(cls: string, object: string, d: { [k: string]: FoamValue }, location?: string): string {
  return `/*--------------------------------*- C++ -*----------------------------------*\\\n  Written by trace (src/tools/thermal/openfoam.ts) for ${OPENFOAM_RELEASE}\n\\*---------------------------------------------------------------------------*/\nFoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${cls};\n${location ? `    location    "${location}";\n` : ''}    object      ${object};\n}\n\n${body(d)}`
}

// ------------------------------------------------------------------ the case description

const Vec = z.tuple([z.number(), z.number(), z.number()])
export const SolidBox = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), min: Vec, max: Vec, k: z.number().positive(), rho: z.number().positive(), cp: z.number().positive(), power_w: z.number().min(0).default(0), emissivity: z.number().min(0).max(1).default(0.9) }).strict()
export type SolidBox = z.output<typeof SolidBox>

export const Face = z.enum(['x-', 'x+', 'y-', 'y+', 'z-', 'z+'])
export type Face = z.output<typeof Face>

export const CfdSetup = z.object({
  domain: z.object({ min: Vec, max: Vec }).strict().describe('the fluid box (m); gravity is -z'),
  enclosure_stl: z.string().optional().describe('an enclosure surface (STL) that bounds the air instead of the box (walls), with vents as named regions'),
  solids: z.array(SolidBox).min(1),
  ambient_c: z.number(),
  pressure_pa: z.number().positive().default(101325),
  flow: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('natural') }).strict(),
    z.object({ kind: z.literal('fixed'), inlet: Face, outlet: Face, flow_m3_s: z.number().positive() }).strict(),
    z.object({ kind: z.literal('fan'), inlet: Face, outlet: Face, curve: z.array(z.tuple([z.number().min(0), z.number()])).min(2).describe('[[flow m^3/s, pressure rise Pa], ...]') }).strict(),
  ]).default({ kind: 'natural' }),
  /** walls of the domain box that are closed (adiabatic no-slip) in natural convection; the rest are open */
  closed: z.array(Face).default([]),
  equation_of_state: z.enum(['perfectGas', 'Boussinesq']).default('perfectGas'),
  radiation: z.enum(['none', 'fvDOM', 'P1']).default('none'),
  cell_m: z.number().positive().describe('background cell size (m)'),
  refinement: z.number().int().min(0).max(5).default(2).describe('snappyHexMesh levels at the solids'),
  steady: z.boolean().default(true),
  iterations: z.number().int().min(10).max(1e6).default(2000).describe('steady: iterations; transient: end time is `end_time_s`'),
  end_time_s: z.number().positive().default(600),
  dt_s: z.number().positive().default(0.05),
  residual: z.number().positive().default(1e-5),
  probes: z.array(z.object({ name: z.string(), at: Vec }).strict()).default([]),
  procs: z.number().int().min(1).max(256).default(1),
}).strict()
export type CfdSetup = z.output<typeof CfdSetup>

export const FLUID = 'air'
const turbulent = (s: CfdSetup): boolean => s.flow.kind !== 'natural'

const faceBox = (f: Face): { axis: 0 | 1 | 2; side: 0 | 1 } => ({ axis: (['x', 'y', 'z'].indexOf(f[0]!) as 0 | 1 | 2), side: f[1] === '+' ? 1 : 0 })

/** The estimated cell count: the background box plus refinement near the solids (each level splits a cell into 8). */
export function estimateCells(s: CfdSetup): number {
  const [a, b] = [s.domain.min, s.domain.max]
  const bg = ((b[0] - a[0]) * (b[1] - a[1]) * (b[2] - a[2])) / s.cell_m ** 3
  let near = 0
  for (const sb of s.solids) {
    const pad = 2 * s.cell_m
    near += ((sb.max[0] - sb.min[0] + 2 * pad) * (sb.max[1] - sb.min[1] + 2 * pad) * (sb.max[2] - sb.min[2] + 2 * pad)) / s.cell_m ** 3
  }
  return Math.round(bg + near * (8 ** s.refinement - 1))
}

function fieldFile(name: string, cls: 'volScalarField' | 'volVectorField', dims: string, internal: string, patches: Record<string, Record<string, FoamValue>>, region: string): string {
  // constraint patches (processor, …) first, as ESI's tutorials do; then the patterns
  return foamFile(cls, name, { dimensions: raw(dims), internalField: raw(`uniform ${internal}`), boundaryField: { '#includeEtc': raw('"caseDicts/setConstraintTypes"'), ...patches } as { [k: string]: FoamValue } }, `0/${region}`)
}

const interfaceT = (solid: boolean, radiation: boolean): Record<string, FoamValue> => ({
  type: 'compressible::turbulentTemperatureRadCoupledMixed', Tnbr: 'T', kappaMethod: solid ? 'solidThermo' : 'fluidThermo',
  qrNbr: radiation && solid ? 'qr' : 'none', qr: radiation && !solid ? 'qr' : 'none', value: raw('$internalField'),
})

/** The case: path (relative to the case root) → file text. */
export function writeCase(input: z.input<typeof CfdSetup>): { files: Map<string, string>; setup: CfdSetup; cells: number; solver: string; script: string } {
  const s = CfdSetup.parse(input)
  const files = new Map<string, string>()
  const T0 = s.ambient_c + 273.15
  const rad = s.radiation !== 'none'
  const regions = s.solids.map((x) => x.name)
  const solver = s.steady ? 'chtMultiRegionSimpleFoam' : 'chtMultiRegionFoam'
  // ---- mesh
  const [a, b] = [s.domain.min, s.domain.max]
  const n = [0, 1, 2].map((i) => Math.max(4, Math.round((b[i]! - a[i]!) / s.cell_m)))
  const v = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]], [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]]
  const faceVerts: Record<Face, number[]> = { 'x-': [0, 4, 7, 3], 'x+': [1, 2, 6, 5], 'y-': [0, 1, 5, 4], 'y+': [3, 7, 6, 2], 'z-': [0, 3, 2, 1], 'z+': [4, 5, 6, 7] }
  const kindOf = (f: Face): 'inlet' | 'outlet' | 'open' | 'wall' => {
    if (s.flow.kind !== 'natural') return f === s.flow.inlet ? 'inlet' : f === s.flow.outlet ? 'outlet' : 'wall'
    return s.closed.includes(f) || s.enclosure_stl ? 'wall' : 'open'
  }
  const faces = Face.options
  const boundary: Record<string, FoamValue> = {}
  for (const f of faces) {
    const k = kindOf(f)
    const name = `${k === 'wall' ? 'wall' : k}_${f.replace('-', 'min').replace('+', 'max')}`
    boundary[name] = { type: k === 'wall' ? 'wall' : 'patch', faces: raw(`((${faceVerts[f].join(' ')}))`) }
  }
  files.set('system/blockMeshDict', foamFile('dictionary', 'blockMeshDict', {
    scale: 1, vertices: raw(`(\n${v.map((p) => `    (${p.map(fmt).join(' ')})`).join('\n')}\n)`),
    blocks: raw(`(hex (0 1 2 3 4 5 6 7) (${n.join(' ')}) simpleGrading (1 1 1))`), edges: raw('()'),
    boundary: raw(`(\n${Object.entries(boundary).map(([k, x]) => `    ${k}\n    {\n        type ${(x as Record<string, FoamValue>).type as string};\n        faces ${((x as Record<string, FoamValue>).faces as Raw).text};\n    }`).join('\n')}\n)`),
  }))
  // a point inside the air, away from every solid
  const inAir = ((): [number, number, number] => {
    const p: [number, number, number] = [a[0] + 0.37 * s.cell_m + 0.013 * (b[0] - a[0]), a[1] + 0.41 * s.cell_m + 0.017 * (b[1] - a[1]), a[2] + 0.43 * s.cell_m + 0.019 * (b[2] - a[2])]
    for (const x of s.solids) if (p.every((c, i) => c >= x.min[i]! && c <= x.max[i]!)) throw new ToolError('cfd: the domain corner is inside a solid: enlarge the domain')
    return p
  })()
  const geometry: Record<string, FoamValue> = {}
  const surfaces: Record<string, FoamValue> = {}
  for (const x of s.solids) {
    geometry[x.name] = { type: 'searchableBox', min: raw(`(${x.min.map(fmt).join(' ')})`), max: raw(`(${x.max.map(fmt).join(' ')})`) }
    surfaces[x.name] = { level: raw(`(${s.refinement} ${s.refinement})`), faceZone: x.name, cellZone: x.name, cellZoneInside: 'inside' }
  }
  if (s.enclosure_stl) {
    geometry['enclosure.stl'] = { type: 'triSurfaceMesh', name: 'enclosure' }
    surfaces.enclosure = { level: raw(`(${Math.max(0, s.refinement - 1)} ${s.refinement})`), patchInfo: { type: 'wall' } }
  }
  files.set('system/snappyHexMeshDict', foamFile('dictionary', 'snappyHexMeshDict', {
    castellatedMesh: true, snap: true, addLayers: false,
    geometry,
    castellatedMeshControls: {
      maxLocalCells: 2000000, maxGlobalCells: 20000000, minRefinementCells: 0, nCellsBetweenLevels: 2, maxLoadUnbalance: 0.1,
      features: raw('()'), refinementSurfaces: surfaces, resolveFeatureAngle: 30, refinementRegions: {},
      locationInMesh: raw(`(${inAir.map(fmt).join(' ')})`), allowFreeStandingZoneFaces: false,
    },
    snapControls: { nSmoothPatch: 3, tolerance: 2.0, nSolveIter: 30, nRelaxIter: 5 },
    addLayersControls: { relativeSizes: true, layers: {}, expansionRatio: 1.0, finalLayerThickness: 0.3, minThickness: 0.1, nGrow: 0, featureAngle: 30, nRelaxIter: 3, nSmoothSurfaceNormals: 1, nSmoothNormals: 3, nSmoothThickness: 10, maxFaceThicknessRatio: 0.5, maxThicknessToMedialRatio: 0.3, minMedialAxisAngle: 90, nBufferCellsNoExtrude: 0, nLayerIter: 50 },
    meshQualityControls: { '#includeEtc': raw('"caseDicts/mesh/generation/meshQualityDict.cfg"') },
    mergeTolerance: 1e-6,
  }))
  // ---- regions and physics
  files.set('constant/regionProperties', foamFile('dictionary', 'regionProperties', { regions: raw(`(\n    fluid (${FLUID})\n    solid (${regions.join(' ')})\n)`) }))
  const g = foamFile('uniformDimensionedVectorField', 'g', { dimensions: raw('[0 1 -2 0 0 0 0]'), value: raw('(0 0 -9.81)') })
  files.set('constant/g', g)
  files.set(`constant/${FLUID}/g`, g)
  files.set(`constant/${FLUID}/thermophysicalProperties`, foamFile('dictionary', 'thermophysicalProperties', {
    thermoType: { type: 'heRhoThermo', mixture: 'pureMixture', transport: 'const', thermo: 'hConst', equationOfState: s.equation_of_state, specie: 'specie', energy: 'sensibleEnthalpy' },
    mixture: {
      specie: { molWeight: 28.96 },
      ...(s.equation_of_state === 'Boussinesq' ? { equationOfState: { rho0: (s.pressure_pa * 28.96e-3) / (8.314462618 * T0), T0, beta: 1 / T0 } } : {}),
      thermodynamics: { Cp: 1007, Hf: 0 },
      // air near 300 K, Incropera 7th ed. table A.4: mu 184.6e-7 Pa s, Pr 0.707
      transport: { mu: 1.846e-5, Pr: 0.707 },
    },
  }))
  files.set(`constant/${FLUID}/turbulenceProperties`, foamFile('dictionary', 'turbulenceProperties', turbulent(s)
    ? { simulationType: 'RAS', RAS: { RASModel: 'kOmegaSST', turbulence: 'on', printCoeffs: 'on' } }
    : { simulationType: 'laminar' }))
  files.set(`constant/${FLUID}/radiationProperties`, foamFile('dictionary', 'radiationProperties', rad
    ? {
        radiation: 'on', radiationModel: s.radiation, solverFreq: 10,
        ...(s.radiation === 'fvDOM' ? { fvDOMCoeffs: { nPhi: 3, nTheta: 5, tolerance: 1e-3, maxIter: 10 } } : {}),
        absorptionEmissionModel: 'none', scatterModel: 'none', sootModel: 'none',
      }
    : { radiation: 'off', radiationModel: 'none' }))
  if (rad) {
    const props: Record<string, FoamValue> = { '.*': { type: 'lookup', emissivity: 0.9, absorptivity: 0.9 } }
    for (const x of s.solids) props[`${FLUID}_to_${x.name}`] = { type: 'lookup', emissivity: x.emissivity, absorptivity: x.emissivity }
    files.set(`constant/${FLUID}/boundaryRadiationProperties`, foamFile('dictionary', 'boundaryRadiationProperties', props))
  }
  for (const x of s.solids) {
    files.set(`constant/${x.name}/thermophysicalProperties`, foamFile('dictionary', 'thermophysicalProperties', {
      thermoType: { type: 'heSolidThermo', mixture: 'pureMixture', transport: 'constIso', thermo: 'hConst', equationOfState: 'rhoConst', specie: 'specie', energy: 'sensibleEnthalpy' },
      mixture: { specie: { molWeight: 50 }, transport: { kappa: x.k }, thermodynamics: { Hf: 0, Cp: x.cp }, equationOfState: { rho: x.rho } },
    }))
    files.set(`constant/${x.name}/radiationProperties`, foamFile('dictionary', 'radiationProperties', { radiation: 'off', radiationModel: 'none' }))
    if (x.power_w > 0) {
      files.set(`system/${x.name}/fvOptions`, foamFile('dictionary', 'fvOptions', {
        // as ESI's cpuCabinet tutorial writes it: sources { h (explicit implicit); }, absolute (W)
        heat: { type: 'scalarSemiImplicitSource', active: true, selectionMode: 'all', volumeMode: 'absolute', sources: { h: raw(`(${fmt(x.power_w)} 0)`) } },
      }))
    }
  }
  // ---- fields (copied over the split regions' own after splitMeshRegions; patch names are matched by pattern)
  const p = s.pressure_pa
  const T = fmt(T0)
  const open = (fld: 'T' | 'U' | 'p_rgh' | 'p' | 'k' | 'omega' | 'nut' | 'alphat'): Record<string, FoamValue> => {
    switch (fld) {
      case 'T': return { type: 'inletOutlet', inletValue: raw(`uniform ${T}`), value: raw(`uniform ${T}`) }
      case 'U': return { type: 'pressureInletOutletVelocity', value: raw('uniform (0 0 0)') }
      case 'p_rgh': return { type: 'prghTotalPressure', p0: raw(`uniform ${fmt(p)}`), value: raw(`uniform ${fmt(p)}`) }
      case 'p': return { type: 'calculated', value: raw(`uniform ${fmt(p)}`) }
      case 'k': return { type: 'inletOutlet', inletValue: raw('uniform 1e-4'), value: raw('uniform 1e-4') }
      case 'omega': return { type: 'inletOutlet', inletValue: raw('uniform 1'), value: raw('uniform 1') }
      default: return { type: 'calculated', value: raw('uniform 0') }
    }
  }
  const wall = (fld: string, coupled: boolean): Record<string, FoamValue> => {
    switch (fld) {
      case 'T': return coupled ? interfaceT(false, rad) : { type: 'zeroGradient' }
      case 'U': return { type: 'noSlip' }
      case 'p_rgh': return { type: 'fixedFluxPressure', value: raw(`uniform ${fmt(p)}`) }
      case 'p': return { type: 'calculated', value: raw(`uniform ${fmt(p)}`) }
      case 'k': return { type: 'kqRWallFunction', value: raw('uniform 1e-4') }
      case 'omega': return { type: 'omegaWallFunction', value: raw('uniform 1') }
      case 'nut': return { type: 'nutkWallFunction', value: raw('uniform 0') }
      default: return { type: 'compressible::alphatWallFunction', Prt: 0.85, value: raw('uniform 0') }
    }
  }
  const inlet = (fld: string): Record<string, FoamValue> => {
    const f = s.flow
    if (fld === 'U') return f.kind === 'fixed' ? { type: 'flowRateInletVelocity', volumetricFlowRate: f.flow_m3_s, value: raw('uniform (0 0 0)') } : { type: 'pressureInletOutletVelocity', value: raw('uniform (0 0 0)') }
    if (fld === 'p_rgh') return f.kind === 'fan'
      ? { type: 'fanPressure', direction: 'in', fanCurve: { type: 'table', values: raw(`(${f.curve.map(([q, dp]) => `(${fmt(q)} ${fmt(dp)})`).join(' ')})`) }, p0: raw(`uniform ${fmt(p)}`), value: raw(`uniform ${fmt(p)}`) }
      : { type: 'fixedFluxPressure', value: raw(`uniform ${fmt(p)}`) }
    if (fld === 'T') return { type: 'fixedValue', value: raw(`uniform ${T}`) }
    if (fld === 'k') return { type: 'turbulentIntensityKineticEnergyInlet', intensity: 0.05, value: raw('uniform 1e-3') }
    if (fld === 'omega') return { type: 'turbulentMixingLengthFrequencyInlet', mixingLength: 0.005, value: raw('uniform 1') }
    return open(fld as 'p')
  }
  const outlet = (fld: string): Record<string, FoamValue> => (fld === 'p_rgh' ? { type: 'prghPressure', p: raw(`uniform ${fmt(p)}`), value: raw(`uniform ${fmt(p)}`) } : open(fld as 'T'))
  const fluidFields = ['T', 'U', 'p_rgh', 'p', 'alphat', ...(turbulent(s) ? ['k', 'omega', 'nut'] : [])]
  const dims: Record<string, [string, 'volScalarField' | 'volVectorField', string]> = {
    T: ['[0 0 0 1 0 0 0]', 'volScalarField', T], U: ['[0 1 -1 0 0 0 0]', 'volVectorField', '(0 0 0)'], p_rgh: ['[1 -1 -2 0 0 0 0]', 'volScalarField', fmt(p)],
    p: ['[1 -1 -2 0 0 0 0]', 'volScalarField', fmt(p)], alphat: ['[1 -1 -1 0 0 0 0]', 'volScalarField', '0'], k: ['[0 2 -2 0 0 0 0]', 'volScalarField', '1e-4'],
    omega: ['[0 0 -1 0 0 0 0]', 'volScalarField', '1'], nut: ['[0 2 -1 0 0 0 0]', 'volScalarField', '0'],
  }
  for (const fld of fluidFields) {
    const patches: Record<string, Record<string, FoamValue>> = {}
    for (const [name] of Object.entries(boundary)) patches[name] = name.startsWith('inlet') ? inlet(fld) : name.startsWith('outlet') ? outlet(fld) : name.startsWith('open') ? open(fld as 'T') : wall(fld, false)
    if (s.enclosure_stl) patches.enclosure = wall(fld, false)
    patches[`${FLUID}_to_.*`] = wall(fld, true)
    const [d, cls, internal] = dims[fld]!
    files.set(`0.orig/${FLUID}/${fld}`, fieldFile(fld, cls, d, internal, patches, FLUID))
  }
  if (rad) {
    // the radiation fields (as ESI's multiRegionHeaterRadiation / thermocoupleTestCase tutorials): qr, and IDefault
    // (fvDOM, grey diffuse walls) or G (P1, Marshak)
    const qr = { '.*': { type: 'calculated', value: raw('$internalField') } }
    files.set(`0.orig/${FLUID}/qr`, fieldFile('qr', 'volScalarField', '[1 0 -3 0 0 0 0]', '0', qr, FLUID))
    if (s.radiation === 'fvDOM') files.set(`0.orig/${FLUID}/IDefault`, fieldFile('IDefault', 'volScalarField', '[1 0 -3 0 0 0 0]', '0', { '.*': { type: 'greyDiffusiveRadiation', value: raw('uniform 0') } }, FLUID))
    else files.set(`0.orig/${FLUID}/G`, fieldFile('G', 'volScalarField', '[1 0 -3 0 0 0 0]', '0', { '.*': { type: 'MarshakRadiation', value: raw('uniform 0') } }, FLUID))
  }
  for (const x of s.solids) {
    files.set(`0.orig/${x.name}/T`, fieldFile('T', 'volScalarField', '[0 0 0 1 0 0 0]', T, { '.*': { type: 'zeroGradient' }, [`${x.name}_to_.*`]: interfaceT(true, rad) }, x.name))
    files.set(`0.orig/${x.name}/p`, fieldFile('p', 'volScalarField', '[1 -1 -2 0 0 0 0]', fmt(p), { '.*': { type: 'calculated', value: raw(`uniform ${fmt(p)}`) } }, x.name))
  }
  // ---- numerics
  const fluidSchemes = {
    ddtSchemes: { default: s.steady ? 'steadyState' : 'Euler' },
    gradSchemes: { default: raw('Gauss linear') },
    divSchemes: {
      default: 'none', 'div(phi,U)': raw(s.steady ? 'bounded Gauss upwind' : 'Gauss upwind'), 'div(phi,K)': raw(s.steady ? 'bounded Gauss upwind' : 'Gauss upwind'),
      'div(phi,h)': raw(s.steady ? 'bounded Gauss upwind' : 'Gauss upwind'), 'div(phi,k)': raw(s.steady ? 'bounded Gauss upwind' : 'Gauss upwind'),
      'div(phi,omega)': raw(s.steady ? 'bounded Gauss upwind' : 'Gauss upwind'), 'div(phi,Ekp)': raw(s.steady ? 'bounded Gauss upwind' : 'Gauss upwind'),
      'div(((rho*nuEff)*dev2(T(grad(U)))))': raw('Gauss linear'), 'div(Ji,Ii_h)': raw('Gauss upwind'),
    },
    laplacianSchemes: { default: raw('Gauss linear corrected') },
    interpolationSchemes: { default: 'linear' },
    snGradSchemes: { default: 'corrected' },
    wallDist: { method: 'meshWave' },
  }
  const solidSchemes = { ddtSchemes: { default: s.steady ? 'steadyState' : 'Euler' }, gradSchemes: { default: raw('Gauss linear') }, divSchemes: { default: 'none' }, laplacianSchemes: { default: raw('Gauss linear corrected') }, interpolationSchemes: { default: 'linear' }, snGradSchemes: { default: 'corrected' } }
  const residuals = { p_rgh: s.residual * 10, U: s.residual * 10, h: s.residual, ...(turbulent(s) ? { 'k|omega': s.residual * 10 } : {}) }
  const algo = s.steady ? 'SIMPLE' : 'PIMPLE'
  files.set(`system/${FLUID}/fvSchemes`, foamFile('dictionary', 'fvSchemes', fluidSchemes, `system/${FLUID}`))
  files.set(`system/${FLUID}/fvSolution`, foamFile('dictionary', 'fvSolution', {
    solvers: {
      'rho.*': { solver: 'PCG', preconditioner: 'DIC', tolerance: 0, relTol: 0 },
      'p_rgh.*': { solver: 'GAMG', smoother: 'DIC', tolerance: 1e-7, relTol: 0.01 },
      '(U|h|e|k|omega|Ii).*': { solver: 'PBiCGStab', preconditioner: 'DILU', tolerance: 1e-7, relTol: 0.1 },
    },
    [algo]: { momentumPredictor: s.flow.kind !== 'natural', nNonOrthogonalCorrectors: 0, pRefCell: 0, pRefValue: p, ...(s.steady ? { residualControl: residuals } : { nCorrectors: 2 }) },
    relaxationFactors: s.steady ? { fields: { rho: 1, p_rgh: 0.7 }, equations: { U: 0.3, h: 0.7, '(k|omega)': 0.7, 'Ii.*': 1 } } : { equations: { '.*': 1 } },
  }, `system/${FLUID}`))
  for (const x of s.solids) {
    files.set(`system/${x.name}/fvSchemes`, foamFile('dictionary', 'fvSchemes', solidSchemes, `system/${x.name}`))
    files.set(`system/${x.name}/fvSolution`, foamFile('dictionary', 'fvSolution', {
      solvers: { 'h.*': { solver: 'PCG', preconditioner: 'DIC', tolerance: 1e-8, relTol: 0.1 } },
      [algo]: { nNonOrthogonalCorrectors: 1, ...(s.steady ? { residualControl: { h: s.residual } } : {}) },
      relaxationFactors: { equations: { h: 1 } },
    }, `system/${x.name}`))
  }
  files.set('system/fvSchemes', foamFile('dictionary', 'fvSchemes', solidSchemes))
  files.set('system/fvSolution', foamFile('dictionary', 'fvSolution', s.steady ? {} : { PIMPLE: { nOuterCorrectors: 1 } }))
  // ---- controls and function objects
  const openPatches = Object.keys(boundary).filter((k) => !k.startsWith('wall'))
  const fo: Record<string, FoamValue> = {
    residuals: { type: 'solverInfo', libs: raw('(utilityFunctionObjects)'), region: FLUID, fields: raw(`(U p_rgh h${turbulent(s) ? ' k omega' : ''})`), writeResidualFields: false },
    wallHeatFlux: { type: 'wallHeatFlux', libs: raw('(fieldFunctionObjects)'), region: FLUID, writeFields: false, writeControl: 'writeTime' },
    ...Object.fromEntries(openPatches.map((pt) => [`enthalpy_${pt}`, { type: 'surfaceFieldValue', libs: raw('(fieldFunctionObjects)'), region: FLUID, regionType: 'patch', name: pt, operation: 'weightedSum', weightField: 'phi', fields: raw('(h)'), writeFields: false, writeControl: 'writeTime' }])),
    ...Object.fromEntries(s.solids.map((x) => [`T_${x.name}`, { type: 'fieldMinMax', libs: raw('(fieldFunctionObjects)'), region: x.name, fields: raw('(T)'), mode: 'magnitude', writeControl: 'writeTime' }])),
    ...Object.fromEntries(s.solids.map((x) => [`Tmean_${x.name}`, { type: 'volFieldValue', libs: raw('(fieldFunctionObjects)'), region: x.name, operation: 'volAverage', fields: raw('(T)'), writeFields: false, writeControl: 'writeTime' }])),
    ...Object.fromEntries(s.solids.map((x) => [`surface_${x.name}`, { type: 'surfaceFieldValue', libs: raw('(fieldFunctionObjects)'), region: FLUID, regionType: 'patch', name: `${FLUID}_to_${x.name}`, operation: 'areaAverage', fields: raw('(T)'), writeFields: false, writeControl: 'writeTime' }])),
    ...Object.fromEntries(s.solids.map((x) => [`area_${x.name}`, { type: 'surfaceFieldValue', libs: raw('(fieldFunctionObjects)'), region: FLUID, regionType: 'patch', name: `${FLUID}_to_${x.name}`, operation: 'areaIntegrate', fields: raw('(T)'), writeFields: false, writeControl: 'writeTime' }])),
    ...(s.probes.length ? { probes: { type: 'probes', libs: raw('(sampling)'), region: FLUID, fields: raw('(T U)'), probeLocations: raw(`(${s.probes.map((q) => `(${q.at.map(fmt).join(' ')})`).join(' ')})`), writeControl: 'writeTime' } } : {}),
  }
  files.set('system/controlDict', foamFile('dictionary', 'controlDict', {
    application: solver, startFrom: 'startTime', startTime: 0, stopAt: 'endTime',
    endTime: s.steady ? s.iterations : s.end_time_s, deltaT: s.steady ? 1 : s.dt_s,
    writeControl: s.steady ? 'timeStep' : 'adjustableRunTime', writeInterval: s.steady ? Math.max(1, Math.round(s.iterations / 4)) : s.end_time_s / 20,
    purgeWrite: 2, writeFormat: 'ascii', writePrecision: 8, writeCompression: 'off', timeFormat: 'general', timePrecision: 8, runTimeModifiable: true,
    ...(s.steady ? {} : { adjustTimeStep: 'yes', maxCo: 0.8, maxDi: 10 }),
    functions: fo,
  }))
  files.set('system/decomposeParDict', foamFile('dictionary', 'decomposeParDict', { numberOfSubdomains: s.procs, method: 'scotch' }))
  for (const r of [FLUID, ...regions]) files.set(`system/${r}/decomposeParDict`, files.get('system/decomposeParDict')!)
  files.set('system/meshQualityDict', foamFile('dictionary', 'meshQualityDict', { '#includeEtc': raw('"caseDicts/mesh/generation/meshQualityDict.cfg"') }))
  const par = s.procs > 1
  const script = [
    'set -e',
    'BASHRC="${OPENFOAM_BASHRC:-/usr/lib/openfoam/openfoam2412/etc/bashrc}"',
    '[ -f "$BASHRC" ] && set +e && . "$BASHRC" && set -e',
    'command -v blockMesh >/dev/null || { echo "OpenFOAM is not installed (OPENFOAM_BASHRC)"; exit 127; }',
    'cd case',
    'blockMesh > log.blockMesh 2>&1',
    'snappyHexMesh -overwrite > log.snappyHexMesh 2>&1',
    'checkMesh > log.checkMesh 2>&1 || true',
    'splitMeshRegions -cellZones -overwrite > log.splitMeshRegions 2>&1',
    `for r in ${[FLUID, ...regions].join(' ')}; do mkdir -p 0/$r; cp 0.orig/$r/* 0/$r/; done`,
    ...(par
      ? [`decomposePar -allRegions -force > log.decomposePar 2>&1`, `mpirun --allow-run-as-root -np ${s.procs} ${solver} -parallel > log.${solver} 2>&1`, 'reconstructPar -allRegions -latestTime > log.reconstructPar 2>&1']
      : [`${solver} > log.${solver} 2>&1`]),
    'foamToVTK -allRegions -latestTime > log.foamToVTK 2>&1 || true',
    'cd ..',
    'tar czf "$OUT_VTK" -C case VTK 2>/dev/null || tar czf "$OUT_VTK" -T /dev/null',
    'tar czf "$OUT_POST" -C case postProcessing',
    'tar czf "$OUT_LOGS" -C case $(cd case && ls log.*)',
  ].join('\n')
  files.set('Allrun', `#!/bin/bash\n${script}\n`)
  return { files, setup: s, cells: estimateCells(s), solver, script }
}

// ------------------------------------------------------------------ results

/** A postProcessing .dat file: comment lines start with '#'; the last comment line names the columns. */
export function parseDat(text: string): { columns: string[]; rows: string[][] } {
  const lines = text.split('\n')
  const head = lines.filter((l) => l.startsWith('#')).pop() ?? '#'
  // OpenFOAM separates columns with tabs (a vector cell holds spaces); a file without tabs is split on whitespace
  const split = (l: string): string[] => (l.includes('\t') ? l.split(/\t+/) : l.split(/\s+/)).map((x) => x.trim()).filter(Boolean)
  const columns = split(head.replace(/^#\s*/, ''))
  const rows = lines.filter((l) => l.trim() && !l.startsWith('#')).map((l) => split(l.trim()))
  return { columns, rows }
}

export interface CfdResult {
  regions: { name: string; max_c: number | null; mean_c: number | null; surface_c: number | null; area_m2: number | null; heat_w: number | null; h_eff: number | null }[]
  residuals: { columns: string[]; last: Record<string, number>; iterations: number; converged: boolean }
  balance: { input_w: number; walls_w: number; enthalpy_w: number; out_w: number; error: number | null }
  probes: { name: string; t_c: number | null; u_m_s: number | null }[]
}

const lastNumber = (rows: string[][], col: number): number | null => {
  const r = rows[rows.length - 1]
  const v = r ? Number(r[col]) : NaN
  return Number.isFinite(v) ? v : null
}

/** Read the postProcessing tree of a finished run. */
export function readResults(post: string, s: CfdSetup): CfdResult {
  const find = (name: string, file: string): string | null => {
    const d = join(post, name)
    if (!existsSync(d)) return null
    const times = readdirSync(d).filter((t) => statSync(join(d, t)).isDirectory()).sort((a, b) => Number(a) - Number(b))
    for (const t of times.reverse()) {
      const files = readdirSync(join(d, t)).filter((f) => f.startsWith(file))
      if (files[0]) return readFileSync(join(d, t, files[0]), 'utf8')
    }
    return null
  }
  const K = 273.15
  const whf = find('wallHeatFlux', 'wallHeatFlux')
  const flux = new Map<string, number>()
  if (whf) for (const r of parseDat(whf).rows) { const v = Number(r[r.length - 1]); if (r[1] && Number.isFinite(v)) flux.set(r[1], v) }
  const regions = s.solids.map((x) => {
    const mm = find(`T_${x.name}`, 'fieldMinMax')
    const mean = find(`Tmean_${x.name}`, 'volFieldValue')
    const surf = find(`surface_${x.name}`, 'surfaceFieldValue')
    const area = find(`area_${x.name}`, 'surfaceFieldValue')
    const mmD = mm ? parseDat(mm) : null
    const maxCol = mmD ? mmD.columns.findIndex((c) => /^max/.test(c)) : -1
    const maxK = mmD && maxCol >= 0 ? lastNumber(mmD.rows, maxCol) : null
    const meanK = mean ? lastNumber(parseDat(mean).rows, 1) : null
    const surfK = surf ? lastNumber(parseDat(surf).rows, 1) : null
    const integral = area ? lastNumber(parseDat(area).rows, 1) : null
    const A = integral !== null && surfK ? integral / surfK : null
    // wallHeatFlux on the fluid side is positive into the fluid's walls; heat leaving the solid enters the air
    const q = flux.has(`${FLUID}_to_${x.name}`) ? -flux.get(`${FLUID}_to_${x.name}`)! : null
    const dT = surfK !== null ? surfK - (s.ambient_c + K) : null
    return { name: x.name, max_c: maxK === null ? null : maxK - K, mean_c: meanK === null ? null : meanK - K, surface_c: surfK === null ? null : surfK - K, area_m2: A, heat_w: q, h_eff: q !== null && A && dT ? q / (A * dT) : null }
  })
  const res = find('residuals', 'solverInfo')
  const rd = res ? parseDat(res) : { columns: [], rows: [] }
  const last: Record<string, number> = {}
  rd.columns.forEach((c, i) => { if (/_initial$/.test(c)) { const v = lastNumber(rd.rows, i); if (v !== null) last[c] = v } })
  const walls = [...flux.entries()].filter(([k]) => !k.startsWith(`${FLUID}_to_`)).reduce((a, [, v]) => a + v, 0)
  let enthalpy = 0
  for (const f of readdirSync(post).filter((d) => d.startsWith('enthalpy_'))) {
    const t = find(f, 'surfaceFieldValue')
    const v = t ? lastNumber(parseDat(t).rows, 1) : null
    if (v !== null) enthalpy += v
  }
  const input = s.solids.reduce((a, x) => a + x.power_w, 0)
  const out = -walls + enthalpy
  const probes = s.probes.map((p) => ({ name: p.name, t_c: null as number | null, u_m_s: null as number | null }))
  const pt = find('probes', 'T')
  if (pt) { const d = parseDat(pt); const r = d.rows[d.rows.length - 1]; probes.forEach((p, i) => { const v = Number(r?.[i + 1]); p.t_c = Number.isFinite(v) ? v - K : null }) }
  const pu = find('probes', 'U')
  if (pu) {
    const line = pu.split('\n').filter((l) => l.trim() && !l.startsWith('#')).pop() ?? ''
    const vecs = [...line.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!.trim().split(/\s+/).map(Number))
    probes.forEach((p, i) => { const v = vecs[i]; p.u_m_s = v ? Math.hypot(...v) : null })
  }
  return {
    regions, residuals: { columns: rd.columns, last, iterations: rd.rows.length, converged: Object.values(last).every((v) => v <= s.residual * 10) && Object.keys(last).length > 0 },
    balance: { input_w: input, walls_w: walls, enthalpy_w: enthalpy, out_w: out, error: input > 0 ? (out - input) / input : null },
    probes,
  }
}

// ------------------------------------------------------------------ running

export const localMaxCells = (): number => Number(process.env.TRACE_OPENFOAM_LOCAL_MAX_CELLS ?? 150_000)

export function openfoamInstalled(): boolean {
  const rc = process.env.OPENFOAM_BASHRC ?? '/usr/lib/openfoam/openfoam2412/etc/bashrc'
  return existsSync(rc) || spawnSync('sh', ['-c', 'command -v chtMultiRegionSimpleFoam'], { encoding: 'utf8' }).status === 0
}

export interface CfdRun { result: CfdResult; vtk: Uint8Array | null; logs: Uint8Array | null; post: Uint8Array | null; where: Backend; seconds: number; cells_estimate: number; files: Map<string, string> }

/** Write the case, run it through runJob (kind openfoam; the CPU queue by default) and read the results. */
export async function runCfd(input: z.input<typeof CfdSetup>, o: { remote?: 'auto' | 'always' | 'never'; timeoutSeconds?: number; stl?: string } = {}): Promise<CfdRun> {
  const c = writeCase(input)
  const mode = o.remote ?? 'auto'
  // CFD runs take minutes to hours: they go to the CPU queue unless told otherwise (remote=never)
  const wantRemote = mode !== 'never'
  const where = backendFor({ gpu: false, remote: wantRemote })
  if (where === 'local' && !openfoamInstalled()) throw new ToolError(`OpenFOAM is not installed here (${OPENFOAM_RELEASE}; set OPENFOAM_BASHRC), and no CPU queue is configured (TRACE_GPU_QUEUE): the CFD path needs one of them`)
  if (where === 'local' && c.cells > localMaxCells() && mode === 'auto') throw new ToolError(`the CFD mesh is about ${c.cells} cells, above the local cap TRACE_OPENFOAM_LOCAL_MAX_CELLS (${localMaxCells()}): set TRACE_GPU_QUEUE to run it on the CPU queue, coarsen cell_m, or pass remote=never to run it here anyway`)
  const dir = scratchDir('trace-openfoam-in-')
  try {
    const inputs: Record<string, string> = {}
    for (const [rel, text] of c.files) {
      const p = join(dir, 'case', rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
      inputs[`case/${rel}`] = p
    }
    if (c.setup.enclosure_stl) {
      const stl = o.stl ?? c.setup.enclosure_stl
      inputs['case/constant/triSurface/enclosure.stl'] = stl
    }
    const r = await runJob({
      kind: 'openfoam', gpu: false, remote: wantRemote, timeoutSeconds: o.timeoutSeconds ?? 6 * 3600,
      argv: ['bash', '-c', `cd '{dir}/in' && OUT_VTK='{out:vtk.tar.gz}' OUT_POST='{out:post.tar.gz}' OUT_LOGS='{out:logs.tar.gz}' bash case/Allrun`],
      inputs, outputs: ['vtk.tar.gz', 'post.tar.gz', 'logs.tar.gz'], vcpus: c.setup.procs, env: { OMP_NUM_THREADS: '1' },
    })
    if (r.exitCode !== 0 || !r.outputs['post.tar.gz']) throw new ToolError(`the OpenFOAM run failed (exit ${r.exitCode}): ${(r.stdout + r.stderr).slice(-600)}`)
    const ex = scratchDir('trace-openfoam-out-')
    try {
      const t = spawnSync('tar', ['xzf', r.outputs['post.tar.gz'], '-C', ex])
      if (t.status !== 0) throw new ToolError('could not unpack the OpenFOAM results')
      const result = readResults(join(ex, 'postProcessing'), c.setup)
      const rd = (n: string): Uint8Array | null => (r.outputs[n] ? new Uint8Array(readFileSync(r.outputs[n])) : null)
      return { result, vtk: rd('vtk.tar.gz'), logs: rd('logs.tar.gz'), post: rd('post.tar.gz'), where: r.where, seconds: r.seconds, cells_estimate: c.cells, files: c.files }
    } finally {
      rmSync(ex, { recursive: true, force: true })
      for (const p of Object.values(r.outputs)) rmSync(p, { force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The case files as a list for the run record (paths relative to the case). */
export const caseListing = (files: Map<string, string>): string => [...files.keys()].sort().join('\n')

// ------------------------------------------------------------------ from a board

export interface BoardBox { x0: number; y0: number; x1: number; y1: number; thickness: number; k_eff: number; rho: number; cp: number; emissivity: number }

/**
 * The CFD setup for a board: the board box (in-plane effective conductivity), each powered part as a mould-compound
 * block of `body_height_m` over its pads, and an air domain of `margin` board sizes around it (natural convection),
 * or a duct along x (forced: fixed flow or a fan curve).
 */
export function boardSetup(b: BoardBox, parts: readonly { ref: string; x0: number; y0: number; x1: number; y1: number; power_w: number }[], o: {
  ambient_c: number; vertical: boolean; flow: CfdSetup['flow']; radiation: CfdSetup['radiation']; cell_m?: number; refinement?: number; body_height_m?: number; margin?: number; steady?: boolean; procs?: number; probes?: CfdSetup['probes']; iterations?: number
}): z.input<typeof CfdSetup> {
  const W = b.x1 - b.x0
  const H = b.y1 - b.y0
  const t = b.thickness
  const hb = o.body_height_m ?? 1e-3
  // board in x-y; when vertical, its y axis is turned to z (gravity -z)
  const place = (x: number, y: number, z: number): [number, number, number] => (o.vertical ? [x, z, y] : [x, y, z])
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { min: [number, number, number]; max: [number, number, number] } => {
    const p = place(x0, y0, z0)
    const q = place(x1, y1, z1)
    return { min: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], max: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])] }
  }
  const solids: z.input<typeof SolidBox>[] = [{ name: 'board', ...box(0, 0, -t, W, H, 0), k: b.k_eff, rho: b.rho, cp: b.cp, emissivity: b.emissivity }]
  for (const p of parts) {
    if (!(p.power_w > 0)) continue
    solids.push({ name: `part_${p.ref.replace(/[^A-Za-z0-9_]/g, '_')}`, ...box(p.x0 - b.x0, p.y0 - b.y0, 0, p.x1 - b.x0, p.y1 - b.y0, hb), k: MOLD.k.value, rho: MOLD.rho.value, cp: MOLD.cp.value, power_w: p.power_w, emissivity: 0.9 })
  }
  const m = o.margin ?? 1
  const L = Math.max(W, H)
  const forced = o.flow.kind !== 'natural'
  const lo = place(-m * L, -m * L, -m * L)
  const hi = place(W + (forced ? 2 * m : m) * L, H + m * L, (forced ? m : 2 * m) * L)
  const domain = { min: [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])] as [number, number, number], max: [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])] as [number, number, number] }
  return {
    domain, solids, ambient_c: o.ambient_c, flow: o.flow, radiation: o.radiation, cell_m: o.cell_m ?? L / 12, refinement: o.refinement ?? 2,
    steady: o.steady ?? true, procs: o.procs ?? 1, probes: o.probes ?? [], ...(o.iterations ? { iterations: o.iterations } : {}),
  }
}

/** The textbook validation case: a heated vertical aluminium plate in still air, at two mesh levels, with the
 * Churchill & Chu coefficient at the plate's own rise for comparison (thermal.validate solver=cfd). */
export function verticalPlateCase(level: number, o: { power_w?: number; side_m?: number; ambient_c?: number } = {}): { setup: z.input<typeof CfdSetup>; reference: (surfaceC: number) => number } {
  const side = o.side_m ?? 0.1
  const P = o.power_w ?? 2.5
  const amb = o.ambient_c ?? 25
  const t = 2e-3
  const setup: z.input<typeof CfdSetup> = {
    domain: { min: [-side, -side / 2, -side], max: [2 * side, side / 2 + t, 2 * side] },
    solids: [{ name: 'plate', min: [0, 0, 0], max: [side, t, side], k: 167, rho: 2700, cp: 896, power_w: P, emissivity: 0.09 }],
    ambient_c: amb, flow: { kind: 'natural' }, radiation: 'none', cell_m: side / (8 * 2 ** level), refinement: 2, steady: true, iterations: 3000,
    closed: ['z-'],
  }
  return { setup, reference: (surfaceC) => churchillChu(surfaceC - amb, side, amb) }
}

