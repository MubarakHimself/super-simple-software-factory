"""Put `adws/` on sys.path so tests import adw_modules the way an ADW does.

The ADW scripts live in adws/ and run from the repo root, so `adw_modules` is a
top-level package to them. pytest is invoked from the repo root too (see
pyproject.toml's `testpaths = ["adws/tests"]`), which does not put adws/ on the
path by itself — hence this file rather than a package __init__.
"""

import sys
from pathlib import Path

ADWS = Path(__file__).resolve().parent.parent
if str(ADWS) not in sys.path:
    sys.path.insert(0, str(ADWS))
