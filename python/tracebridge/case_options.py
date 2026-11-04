"""Case options before any model is built (docs/ontology.md "Assembly reasoning"; plan P7.4): the bridge method
`case.options`.

Every combination of the choices that define a case is generated as a configuration option, and each is tried
against feasibility rules that use only regions and their relations, read from the board facts (no geometry kernel:
boxes, edges, corners, counts and sizes):

  template   printed-shell (a base and a lid) | extruded-box (a tube and end plates) | din-rail (the shell on a rail foot)
  mounting   screws (in the board's mounting holes) | rests (rests on the floor, posts in the lid) | guides (the board
             slides along guides on the side walls)
  closure    lid (a lid pressed onto the base) | end-plates (two plates pressed over a tube's ends)
  process    the processes the caller offers (each with its largest part and its thinnest wall)

The rules, each with the words a person reads when it prunes an option:

  closure-of-template     the shell and the DIN rail enclosure close with a lid; the extruded box with end plates
  mounting-of-template    the extruded box holds the board in guides; the shell and the DIN rail enclosure screw it
                          into its mounting holes when it has some, and clamp it between rests and posts otherwise
  nothing-floats          rests and posts need at least three corners of the board free of parts
  guides-need-free-edges  a guide runs along each long side of the board, over and under its edge: no part may sit
                          within its reach there
  board-slides-in         the board slides into the tube along x: no part may stick out past the north or south edge
  fits-the-process        the case's outside (estimated from the board's box, the walls, the clearances and the
                          tallest parts) within the process's largest part

Options that pass every rule are ranked: the printed shell in powder printing is trace's recommendation unless the
requirements ask for something else (a DIN rail, a metal or rugged case); each option says why and what it gives
up. Pruned options are kept, each with the first rule that pruned it, so a person can see why an obvious choice was
not offered.
"""
from __future__ import annotations

import itertools
import re
from typing import Any

from . import BridgeError, method

TEMPLATES = ("printed-shell", "extruded-box", "din-rail")
MOUNTINGS = ("screws", "rests", "guides")
CLOSURES = ("lid", "end-plates")

TEMPLATE_WORDS = {
    "printed-shell": "printed two-part shell",
    "extruded-box": "extruded box with end plates",
    "din-rail": "DIN rail enclosure",
}
MOUNTING_WORDS = {"screws": "screwed into its mounting holes", "rests": "held between rests and lid posts",
                  "guides": "slid along guides"}
RIGHT_WHEN = {
    "printed-shell": "the simplest case: two printed parts, the board screwed or clamped inside",
    "extruded-box": "right when the board should slide into a long, closed tube, such as a duct or a handheld",
    "din-rail": "right when it mounts on a rail in a cabinet",
}
GIVES_UP = {
    "printed-shell": "nothing to mount it by: it sits on a shelf or is fixed by its own screws",
    "extruded-box": "a longer case (the end plates' skirts), and parts near the long edges must keep clear of the guides",
    "din-rail": "about 5 mm more height for the rail foot, and it must hang on a rail",
}

# The shell's defaults (src/tools/mech/settings.ts), for the size estimate.
WALL, LIP, FIT, EDGE, FLOOR, LID = 2.0, 2.0, 0.2, 0.5, 2.0, 2.0
ABOVE, BELOW, MIN_STANDOFF = 1.0, 1.0, 3.0
GUIDE_REACH = EDGE + 1.0  # the extruded box's guides reach this far in from its wall (boxes.GUIDE_OVER_MM)
SKIRT = LIP + FIT  # an end plate's skirt over the tube
RAIL_FOOT = 5.4  # the DIN rail foot's height (boxes.RAIL_*)
CORNER = 7.0  # a rest's side (the standoff diameter)
SEARCH = 25.0  # how far along each edge from a corner a rest may move to keep clear of the parts (shell.SUPPORT_SEARCH_MM)


def _bbox(points: list[list[float]]) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


class Regions:
    """The board as regions and relations: its box, each part's box and side, which edge a part is at, which parts
    stick out past an edge, which corners are free, how many mounting holes it has, and how tall it stands."""

    def __init__(self, facts: dict[str, Any]):
        if not isinstance(facts, dict) or not facts.get("outline"):
            raise BridgeError("case.options needs the board facts (mech.board), with the outline")
        self.box = _bbox(facts["outline"])
        self.parts = [p for p in facts.get("parts") or [] if isinstance(p, dict) and isinstance(p.get("box"), dict)]
        self.holes = [h for h in facts.get("holes") or [] if h.get("kind") == "mounting"]
        x0, y0, x1, y1 = self.box
        self.width, self.depth = x1 - x0, y1 - y0
        top = [p["height_mm"] for p in self.parts if p.get("side") == "top"] or [0.0]
        bottom = [p["height_mm"] for p in self.parts if p.get("side") == "bottom"] or [0.0]
        leads = [p.get("below_mm") or 0.0 for p in self.parts]
        self.above = max(max(top) + ABOVE, max(leads) + max(ABOVE, BELOW))
        self.below = max(max(bottom) + BELOW, max(leads) + max(ABOVE, BELOW), MIN_STANDOFF)
        self.thickness = float(facts.get("thickness_mm") or 1.6)

    def pbox(self, p: dict[str, Any]) -> tuple[float, float, float, float]:
        b = p["box"]
        return b["min_x"], b["min_y"], b["max_x"], b["max_y"]

    def sticks_out(self, side: str) -> list[str]:
        """Parts whose box reaches past the board's edge on `side` (KiCad's frame: north is min y)."""
        x0, y0, x1, y1 = self.box
        test = {"north": lambda b: b[1] < y0 - 1e-6, "south": lambda b: b[3] > y1 + 1e-6,
                "west": lambda b: b[0] < x0 - 1e-6, "east": lambda b: b[2] > x1 + 1e-6}[side]
        return sorted(p["ref"] for p in self.parts if test(self.pbox(p)))

    def within_reach_of_long_edges(self, reach: float) -> list[str]:
        """Parts in the band `reach` wide inside the north and south edges (where a guide holds the board)."""
        x0, y0, x1, y1 = self.box
        bands = [(x0, y0, x1, y0 + reach), (x0, y1 - reach, x1, y1)]
        return sorted(p["ref"] for p in self.parts if any(_overlaps(self.pbox(p), b) for b in bands))

    def free_corners(self) -> int:
        """Corners with room for a rest: a square CORNER wide, clear of every part, within SEARCH of the corner along
        its edges (stepped 1 mm at a time, as the shell looks for one)."""
        x0, y0, x1, y1 = self.box
        boxes = [self.pbox(p) for p in self.parts]
        steps = [float(i) for i in range(int(SEARCH) + 1)]
        free = 0
        for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            ex = x0 if sx > 0 else x1 - CORNER
            ey = y0 if sy > 0 else y1 - CORNER
            for dx, dy in itertools.product(steps, steps):
                x, y = ex + sx * dx, ey + sy * dy
                sq = (x, y, x + CORNER, y + CORNER)
                if sq[0] >= x0 and sq[2] <= x1 and sq[1] >= y0 and sq[3] <= y1 and not any(_overlaps(b, sq) for b in boxes):
                    free += 1
                    break
        return free


def _outer(r: Regions, template: str) -> list[float]:
    """The case's outside, estimated from the board's box, the walls, the clearances and the tallest parts."""
    height = FLOOR + r.below + r.thickness + r.above + LID
    if template == "extruded-box":
        return [r.width + 2 * (EDGE + WALL + SKIRT), r.depth + 2 * (EDGE + WALL + SKIRT), height + 2 * SKIRT]
    grow = 2 * (EDGE + LIP + FIT + WALL)
    return [r.width + grow, r.depth + grow, height + (RAIL_FOOT if template == "din-rail" else 0.0)]


def _rules(r: Regions, template: str, mounting: str, closure: str, process: dict[str, Any]) -> tuple[str, str] | None:
    """The first rule that prunes the option, with why in words; None when it is feasible."""
    if (template == "extruded-box") != (closure == "end-plates"):
        return "closure-of-template", (f"the {TEMPLATE_WORDS[template]} closes with "
                                       f"{'end plates' if template == 'extruded-box' else 'a lid'}")
    if template == "extruded-box" and mounting != "guides":
        return "mounting-of-template", "the extruded box holds the board in guides along its walls"
    if template != "extruded-box":
        if mounting == "guides":
            return "mounting-of-template", f"the {TEMPLATE_WORDS[template]} has no guides: it screws or clamps the board"
        if mounting == "screws" and not r.holes:
            return "mounting-of-template", "the board has no mounting holes to screw it down by"
        if mounting == "rests" and r.holes:
            return "mounting-of-template", f"the board has {len(r.holes)} mounting holes, so the case screws it down"
        if mounting == "rests" and r.free_corners() < 3:
            return "nothing-floats", (f"only {r.free_corners()} of the board's corners are free of parts, so rests and "
                                      f"posts cannot hold it level: add mounting holes")
    if template == "extruded-box":
        out = r.sticks_out("north") + r.sticks_out("south")
        if out:
            return "board-slides-in", (f"{', '.join(out)} {'sticks' if len(out) == 1 else 'stick'} out past the board's "
                                       f"long edge, so the board cannot slide into the tube")
        near = r.within_reach_of_long_edges(GUIDE_REACH)
        if near:
            return "guides-need-free-edges", (f"{', '.join(near)} {'sits' if len(near) == 1 else 'sit'} where a guide "
                                              f"holds the board's long edge")
    mx = process.get("max_mm")
    if mx:
        size = sorted(_outer(r, template), reverse=True)
        lim = sorted(mx, reverse=True)
        if any(a > b for a, b in zip(size, lim)):
            return "fits-the-process", (f"the case would be about {' × '.join(f'{v:.0f}' for v in _outer(r, template))} mm, "
                                        f"over {process['label']}'s largest part, {' × '.join(f'{v:g}' for v in mx)} mm")
    return None


KEYWORDS = (
    ("din-rail", re.compile(r"\bdin\b|\brail\b|cabinet|control panel", re.I), 3, "the requirements ask for a DIN rail mount"),
    ("extruded-box", re.compile(r"rugged|metal|alumin|extru|shield|vibration|drop", re.I), 2, "the requirements ask for a rugged or metal case"),
    ("cnc", re.compile(r"rugged|metal|alumin|shield|heat ?sink|thermal", re.I), 2, "the requirements ask for a metal case"),
    ("printed", re.compile(r"low cost|cheap|prototype|first build", re.I), 1, "the requirements ask for a low cost first build"),
)


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def _score(template: str, process: dict[str, Any], reqs: list[str]) -> tuple[int, list[str]]:
    score, why = 0, [RIGHT_WHEN[template]]
    if template == "printed-shell":
        score += 1
    if process.get("recommended"):
        score += 1
        why.append(f"{process['label']} is trace's recommended process ({process.get('why') or 'strong, fine detail, low cost'})")
    for key, rx, points, words in KEYWORDS:
        hit = next((t for t in reqs if rx.search(t)), None)
        if not hit:
            continue
        cnc = process.get("service") == "jlccnc"
        if key == template or (key == "cnc" and cnc) or (key == "printed" and not cnc):
            score += points
            why.append(f"{words} (“{hit[:80]}”)")
    if process.get("service") == "jlccnc" and not any(k[1].search(t) for k in KEYWORDS[1:3] for t in reqs):
        score -= 1
    return score, why


@method("case.options")
def case_options(facts: Any = None, processes: Any = None, requirements: Any = None) -> dict[str, Any]:
    """The bridge method: options() of its parameters."""
    return options({"facts": facts, "processes": processes, "requirements": requirements})


def options(params: dict[str, Any]) -> dict[str, Any]:
    """Every option with whether it is feasible (else the rule that pruned it, in words), the feasible ones ranked."""
    r = Regions(params.get("facts"))
    processes = [p for p in params.get("processes") or [] if isinstance(p, dict) and p.get("id") and p.get("label")]
    if not processes:
        raise BridgeError("case.options needs at least one process to offer")
    reqs = [str(t) for t in params.get("requirements") or [] if t]
    out = []
    for template, mounting, closure, process in itertools.product(TEMPLATES, MOUNTINGS, CLOSURES, processes):
        key = f"{template}/{mounting}/{closure}/{process['id']}"
        label = f"{_cap(TEMPLATE_WORDS[template])}, {process['label']}, board {MOUNTING_WORDS[mounting]}"
        pruned = _rules(r, template, mounting, closure, process)
        o: dict[str, Any] = {"key": key, "label": label,
                             "choices": {"template": template, "mounting": mounting, "closure": closure, "process": process["id"]},
                             "feasible": pruned is None}
        if pruned:
            o["pruned_by"] = {"rule": pruned[0], "why": pruned[1]}
        else:
            score, why = _score(template, process, reqs)
            o.update({"score": score, "why": why, "gives_up": GIVES_UP[template] + (
                "; machined aluminium costs several times a printed case" if process.get("service") == "jlccnc" else ""),
                "size_mm": [round(v, 1) for v in _outer(r, template)]})
        out.append(o)
    feasible = sorted((o for o in out if o["feasible"]), key=lambda o: (-o["score"], TEMPLATES.index(o["choices"]["template"]),
                                                                        [p["id"] for p in processes].index(o["choices"]["process"])))
    for i, o in enumerate(feasible, 1):
        o["rank"] = i
        o["recommended"] = i == 1
    # each design and process with no feasible option, and why, in the words of the rule a person would ask about
    # (not "the shell closes with a lid", which only says that a combination is not a design)
    structural = ("closure-of-template", "mounting-of-template")
    not_offered = []
    for template, process in itertools.product(TEMPLATES, processes):
        mine = [o for o in out if o["choices"]["template"] == template and o["choices"]["process"] == process["id"]]
        if any(o["feasible"] for o in mine):
            continue
        telling = [o for o in mine if o["pruned_by"]["rule"] not in structural] or \
            [o for o in mine if o["pruned_by"]["rule"] == "mounting-of-template" and "holes" in o["pruned_by"]["why"]] or mine
        o = telling[0]
        not_offered.append({"label": f"{_cap(TEMPLATE_WORDS[template])}, {process['label']}", "template": template,
                            "process": process["id"], "rule": o["pruned_by"]["rule"], "why": o["pruned_by"]["why"]})
    return {"options": feasible + [o for o in out if not o["feasible"]],
            "feasible": len(feasible), "pruned": len(out) - len(feasible), "not_offered": not_offered,
            "recommended": feasible[0]["key"] if feasible else None}
