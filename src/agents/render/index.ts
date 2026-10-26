/**
 * The rendering specialist: renders of boards, models and turntables (render.*). Its instructions are the rendering
 * agent's (./prompt.ts); delivery of the renders (committing the run record) goes through the worker like any
 * other repository change.
 */
import type { Specialist } from '../specialist.js'

export const render: Specialist = {
  kind: 'render',
  title: 'Rendering',
  description: 'photographic renders of boards, enclosures and assemblies, and turntables, for documentation and'
    + ' review. Renders show what a design looks like; they are not evidence that it works.',
  memoryAgent: 'render',
  tools: ['render.status', 'render.board', 'render.model', 'render.turntable'],
  workflow: [
    'Start with render_status: is Blender there, which device would render, is ffmpeg there for movies.',
    'Boards: render_board (views top, bottom, iso). Enclosures, assemblies, parts (GLB, STEP, STL, OBJ, VRML):'
      + ' render_model. Turntables: render_turntable (a project or a path).',
    'device=auto (the default) uses a GPU when there is one and the CPU otherwise; use gpu only when a GPU is'
      + ' required, as it fails without one.',
    'Keep the defaults unless asked. Try one view at low size first (e.g. width 640, height 400, samples 16), then'
      + ' render the full set. Renders are slow: render only what was asked.',
    'Look at every image before reporting it (Read the files you wrote, or the run\'s artifacts): framed, lit, the'
      + ' right way up, not blank. Re-render with changed settings if it is wrong.',
    'Use out_dir only when the request asks for files. Never overwrite or edit anyone\'s files.',
    'State the commit the renders came from (the commit field).',
    'The renders are kept in the run record (.trace/project.db) of your checkout. To deliver them, delegate'
      + ' (DELIVERY): the brief asks the worker to commit .trace/project.db (and any files the request asked for)'
      + ' on the branch and open the pull request; the acceptance criterion is that the branch holds the run ids'
      + ' (trace_run on each).',
  ],
  done: [
    'each render asked for exists as a run artifact you have looked at, with its run id, device and duration;',
    'the renders are committed on the branch by the worker (when the job asked for delivery).',
  ],
  escalate: [
    'the model or board cannot be exported or imported (a missing 3D model, a kicad-cli failure);',
    'the request needs a GPU and there is none here and no GPU queue.',
  ],
  delegate: ['Typical brief: commit .trace/project.db with render runs X, Y on this branch and open the PR, listing the run ids.'],
  keywords: [/\brenders?\b|\brendering\b/i, /\bturntable\b/i, /\bblender\b/i, /\bphoto(graph|realistic)/i],
}
