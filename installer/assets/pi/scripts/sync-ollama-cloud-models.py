#!/usr/bin/env python3
"""Sync Pi's Ollama Cloud provider from OpenCode auth and Ollama's live model API.

Default behavior:
- read an existing local Ollama Cloud key from OpenCode/Pi auth;
- fetch https://ollama.com/v1/models;
- regenerate ~/.pi/agent/models.json provider `ollama-cloud` with the live model list.

Use --from-server to copy the VPS OpenCode `ollama-cloud` key into local
OpenCode-compatible auth before refreshing models. The server connection details
are read from ~/.pi/qmx-babysitter/qmx-bmad-watcher.py so the key is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE_URL = "https://ollama.com/v1"
PROVIDER_ID = "ollama-cloud"
KEY_READER = Path.home() / ".pi" / "agent" / "scripts" / "ollama-cloud-key.py"


def local_opencode_auth_paths():
    paths: list[Path] = []
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        paths.append(Path(local_app_data) / "opencode" / "auth.json")
    app_data = os.environ.get("APPDATA")
    if app_data:
        paths.append(Path(app_data) / "opencode" / "auth.json")
    home = Path.home()
    paths.append(home / ".local" / "share" / "opencode" / "auth.json")
    return paths


def read_json(path: Path):
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
    except Exception:
        pass


def read_local_key():
    proc = subprocess.run(
        [sys.executable, str(KEY_READER)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    return None


def parse_watcher_var(text: str, name: str):
    match = re.search(rf"^{name}\s*=\s*(['\"])(.*?)\1", text, re.M)
    if not match:
        raise RuntimeError(f"missing {name} in watcher script")
    return match.group(2)


def fetch_server_key():
    try:
        import paramiko
    except ImportError as exc:
        raise SystemExit("paramiko is required for --from-server") from exc

    watcher = Path.home() / ".pi" / "qmx-babysitter" / "qmx-bmad-watcher.py"
    text = watcher.read_text(encoding="utf-8", errors="replace")
    host = parse_watcher_var(text, "host")
    user = parse_watcher_var(text, "user")
    password = parse_watcher_var(text, "password")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, username=user, password=password, timeout=20, banner_timeout=20, auth_timeout=20)
    command = "python3 - <<'PY'\nimport json, pathlib\nprint(json.loads(pathlib.Path('/root/.local/share/opencode/auth.json').read_text())['ollama-cloud']['key'])\nPY"
    _, stdout, stderr = client.exec_command(command, timeout=60)
    key = stdout.read().decode("utf-8", "replace").strip()
    err = stderr.read().decode("utf-8", "replace").strip()
    client.close()
    if err:
        raise RuntimeError(f"server key fetch stderr: {err}")
    if len(key) < 20:
        raise RuntimeError("server key fetch returned an invalid key length")
    return key


def seed_local_opencode_auth(key: str):
    written: list[Path] = []
    for path in local_opencode_auth_paths():
        data = read_json(path)
        data[PROVIDER_ID] = {"type": "api", "key": key}
        write_json(path, data)
        written.append(path)
    return written


def remove_pi_duplicate_key():
    auth_path = Path.home() / ".pi" / "agent" / "auth.json"
    data = read_json(auth_path)
    removed = data.pop(PROVIDER_ID, None) is not None
    if removed:
        write_json(auth_path, data)
    return removed


def fetch_models(key: str):
    request = urllib.request.Request(
        f"{BASE_URL}/models",
        headers={"Authorization": f"Bearer {key}"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise RuntimeError("Ollama /v1/models did not return a data list")
    ids = sorted({row.get("id") for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)})
    if not ids:
        raise RuntimeError("Ollama /v1/models returned no model ids")
    return ids


def generated_model(model_id: str):
    return {
        "id": model_id,
        "name": f"{model_id} (Ollama Cloud)",
        "input": ["text"],
        "contextWindow": 262144,
        "maxTokens": 32768,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    }


def update_pi_models(model_ids: list[str]):
    models_path = Path.home() / ".pi" / "agent" / "models.json"
    data = read_json(models_path)
    providers = data.setdefault("providers", {})
    existing = providers.get(PROVIDER_ID, {}) if isinstance(providers.get(PROVIDER_ID), dict) else {}

    providers[PROVIDER_ID] = {
        "baseUrl": BASE_URL,
        "api": "openai-completions",
        "apiKey": f"!python {KEY_READER.as_posix()!r}",
        "authHeader": True,
        "compat": {
            "supportsDeveloperRole": False,
            "supportsReasoningEffort": True,
            "supportsUsageInStreaming": True,
            "maxTokensField": "max_tokens",
        },
        "models": [generated_model(model_id) for model_id in model_ids],
    }

    # Preserve user/provider overrides if they were added manually.
    if isinstance(existing.get("modelOverrides"), dict):
        providers[PROVIDER_ID]["modelOverrides"] = existing["modelOverrides"]

    write_json(models_path, data)
    return models_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-server", action="store_true", help="sync the Ollama Cloud key from VPS OpenCode auth first")
    parser.add_argument("--keep-pi-auth", action="store_true", help="do not remove duplicate ~/.pi/agent/auth.json ollama-cloud key")
    args = parser.parse_args()

    key = fetch_server_key() if args.from_server else read_local_key()
    if not key:
        raise SystemExit("No local key found. Run with --from-server once, or seed local OpenCode auth.")

    written = seed_local_opencode_auth(key)
    removed = False if args.keep_pi_auth else remove_pi_duplicate_key()
    model_ids = fetch_models(key)
    models_path = update_pi_models(model_ids)

    print(f"synced_provider={PROVIDER_ID}")
    print(f"model_count={len(model_ids)}")
    print("sample_models=" + ",".join(model_ids[:8]))
    print("models_path=" + str(models_path))
    print("opencode_auth_paths=" + ";".join(str(path) for path in written))
    print(f"removed_duplicate_pi_auth={removed}")


if __name__ == "__main__":
    raise SystemExit(main())
