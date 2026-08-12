# Vendored assets — provenance

Both scripts below are copied **byte-identical** from `~/.pi/agent/scripts/` on the operator's
laptop, 2026-08-12, recovered once already from `~/.pi-backup-20260811` (see MAP.md, spec
`installer-wizard.md` section 6.8). Vendoring them here means a fresh clone can wire ollama-cloud
without the parked tree. `installer/steps.py` compares sha256 against what is on disk before
copying; identical content never parks.

| File | Bytes | sha256 |
|---|---:|---|
| `scripts/ollama-cloud-key.py` | 1929 | `0ad19d977b7e84d632f3fb562ed37c4eac7b38951d045c769b7de03a42203bd8` |
| `scripts/sync-ollama-cloud-models.py` | 7083 | `97e4eb878da08240bebc104f6c07cc978f6c7823259ea05665feef0cd0db1c9c` |

Re-verify after any re-vendor with:

```
python -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" <file>
```

`ollama-cloud.provider.json` in this directory is **not** vendored from anywhere — it is a seed
written for this spec (section 6.7/6.8) carrying just the `ollama-cloud` provider shape plus the
test-lane model (`kimi-k2.7-code`) as a floor. `installer/steps.py` overwrites its `apiKey` field
with the host's real absolute path to the vendored key script before merging it into
`~/.pi/agent/models.json`, then `sync-ollama-cloud-models.py` regenerates the live model list —
the seed only guarantees the provider exists before the key does.
