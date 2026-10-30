from tracebridge.mech import shell

def build(board, settings):
    case = shell.two_part(board, settings)
    # Your changes go here: case.parts["lid"] = case.parts["lid"] - ...  (build123d)
    return case
