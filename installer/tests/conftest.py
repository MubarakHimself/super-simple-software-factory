"""Put `installer/` on sys.path so tests import `steps` the way install.py does.

Mirrors adws/tests/conftest.py: pytest runs from the repo root (see
pyproject.toml's `testpaths`), which does not put installer/ on the path by
itself - hence this file rather than a package __init__.
"""

import sys
from pathlib import Path

INSTALLER = Path(__file__).resolve().parent.parent
if str(INSTALLER) not in sys.path:
    sys.path.insert(0, str(INSTALLER))
