from build123d import Pos
from tracebridge.mech import shell


def build(board, settings):
    # a slimmer case: the lid sits 1.5 mm lower than the template puts it
    case = shell.two_part(board, settings)
    case.parts["lid"] = Pos(0, 0, -1.5) * case.parts["lid"]
    return case
