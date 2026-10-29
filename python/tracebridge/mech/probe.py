"""Ray probes on the solids: where a straight line enters and leaves a shape.

The fit check uses them to see that the case is around the board (a ray from the board out through each side, and up
and down, must meet the case); the rules use them to measure the thickness of the sections a part is built with (the
solid stretch a ray crosses through a wall, the floor or the lid's top). Each probe is OpenCascade's curve-face
intersection on the shape's faces, so it measures the built model, not the parameters it was built from.
"""
from __future__ import annotations

from build123d import Shape
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt
from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

FAR = 1000.0


def hits(shape: Shape, origin: tuple[float, float, float], direction: tuple[float, float, float],
         reach: float = FAR) -> list[float]:
    """The distances along the ray (origin, direction) at which it crosses the shape's faces, nearest first, up to
    `reach`. Touching hits within 1e-6 of each other are merged."""
    if shape is None:
        return []
    inter = IntCurvesFace_ShapeIntersector()
    inter.Load(shape.wrapped, 1e-6)
    inter.Perform(gp_Lin(gp_Pnt(*origin), gp_Dir(*direction)), 0.0, reach)
    if not inter.IsDone():
        return []
    ds = sorted(inter.WParameter(i) for i in range(1, inter.NbPnt() + 1))
    out: list[float] = []
    for d in ds:
        if not out or d - out[-1] > 1e-6:
            out.append(d)
    return out


def first_hit(shapes: list[Shape], origin, direction, reach: float = FAR) -> float | None:
    """The nearest distance along the ray at which it meets any of the shapes, or None when it meets none."""
    ds = [h[0] for s in shapes if (h := hits(s, origin, direction, reach))]
    return min(ds) if ds else None


def intervals(shape: Shape, origin, direction, reach: float = FAR) -> list[tuple[float, float]]:
    """The solid stretches the ray crosses, as (enter, leave) distances, for a ray that starts outside the shape.
    Pairs the crossings in order; an odd count (the ray starts inside, or grazes an edge) drops the last."""
    ds = hits(shape, origin, direction, reach)
    if shape is not None and ds:
        try:
            if shape.is_inside(origin):
                ds = [0.0] + ds
        except Exception:  # noqa: BLE001 - is_inside on an odd compound
            pass
    return [(ds[i], ds[i + 1]) for i in range(0, len(ds) - 1, 2)]
