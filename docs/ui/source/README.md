# Screen sources

These are the design sources for the screens in [`../../ui-design.md`](../../ui-design.md), exported from the design canvas they were drawn in. They are designs, not app code: nothing here is built or shipped.

- `*.dc.html`: one screen each, in the design canvas's component format (HTML with `{{hole}}` bindings and a small logic class). Each expects the canvas runtime as `./support.js`, which is not included; the rendered images are in [`../screens/`](../screens/).
- `canvas.json`: the canvas layout (each screen's title, size and position, and the row titles).

The screens use shadcn/ui's neutral look with Tailwind's colour values written inline, so they read as the shadcn components named in the design doc's component map. Names, numbers, part codes and run ids in them are illustrative.
