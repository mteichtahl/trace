from tracebridge.mech import boxes

def build(board, settings):
    case = boxes.din_rail(board, settings)
    # Your changes go here: case.parts["lid"] = case.parts["lid"] - ...  (build123d)
    return case
