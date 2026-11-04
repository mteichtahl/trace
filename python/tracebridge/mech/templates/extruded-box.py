from tracebridge.mech import boxes

def build(board, settings):
    case = boxes.extruded_box(board, settings)
    # Your changes go here: case.parts["tube"] = case.parts["tube"] - ...  (build123d)
    return case
