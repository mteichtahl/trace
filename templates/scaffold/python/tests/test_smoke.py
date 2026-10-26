def test_imports():
    import importlib
    importlib.import_module("__TR_NAME__".replace("-", "_"))
