"""Compatibility entrypoint for the current economy interaction suite."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('economy-ui.py')),run_name='__main__')
