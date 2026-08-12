#!/usr/bin/env python3
"""Print the Ollama Cloud API key from local OpenCode-compatible auth.

This is intentionally tiny because Pi can call it from models.json via
`apiKey: "!python .../ollama-cloud-key.py"`.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def candidate_paths():
    explicit = os.environ.get("OPENCODE_AUTH_JSON")
    if explicit:
        yield Path(explicit)

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        yield Path(local_app_data) / "opencode" / "auth.json"

    app_data = os.environ.get("APPDATA")
    if app_data:
        yield Path(app_data) / "opencode" / "auth.json"

    home = Path.home()
    yield home / ".local" / "share" / "opencode" / "auth.json"
    yield home / ".config" / "opencode" / "auth.json"

    # Transitional fallback only. The sync script removes this once local
    # OpenCode auth has been seeded, but keeping the fallback makes recovery easy.
    yield home / ".pi" / "agent" / "auth.json"


def read_key(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception as exc:
        raise SystemExit(f"failed to read {path}: {exc}") from exc

    entry = data.get("ollama-cloud")
    if isinstance(entry, dict):
        key = entry.get("key")
        if isinstance(key, str) and key.strip():
            return key.strip()
    return None


def main():
    seen = set()
    for path in candidate_paths():
        path = path.expanduser()
        key_path = str(path).lower()
        if key_path in seen:
            continue
        seen.add(key_path)
        key = read_key(path)
        if key:
            print(key)
            return 0

    print("ollama-cloud key not found in local OpenCode/Pi auth", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
