Cap the systemd journal — it's unbounded by default. Two steps:

**Free space now:**
```bash
journalctl --vacuum-size=200M
```
(or `journalctl --vacuum-time=3d` to keep only the last 3 days)

**Make it permanent** — edit `/etc/systemd/journald.conf`, set under `[Journal]`:
```
SystemMaxUse=200M
SystemKeepFree=500M
```
then:
```bash
systemctl restart systemd-journald
```

That caps the journal at 200M total and it auto-rotates (drops oldest) instead of growing forever.

One note: a big contributor was the express app spamming Python tracebacks during the crash-loop — the `express.py` `raise e` → `return 400` fix you applied earlier stops that, so the journal won't fill nearly as fast now.
