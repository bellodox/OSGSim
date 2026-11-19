#!/usr/bin/env python3
"""Compatibility entrypoint; GPU acceptance checks live under root tests/."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parents[1] / 'tests' / 'acceptance_scene_regression.py'), run_name='__main__')
