from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

if len(sys.argv) != 4:
    raise SystemExit("uso: publish-v353.py <repo-root> <owner/repo> <branch>")

root = Path(sys.argv[1])
repository = sys.argv[2]
branch = sys.argv[3]
token = os.environ.get("SOURCE_PAT", "").strip()
if not token:
    raise SystemExit("SOURCE_PAT mancante")

app_dir = "riflessahairbeauty-app-registratore/Riflessabeautyapp_v3.5.2_receipt_actions"
files = [
    f"{app_dir}/js/app.js",
    f"{app_dir}/index.html",
    f"{app_dir}/electron/main.js",
    f"{app_dir}/tests/automatic-fiscal-closure.test.js",
    "Guida_Riflessa_App_Registratore_3.5.3.txt",
    f"{app_dir}/package-lock.json",
    f"{app_dir}/package.json",
]
old_guide = "Guida_Riflessa_App_Registratore_3.5.2.txt"

headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "riflessa-v353-publisher",
}


def api(method: str, path: str, body: dict | None = None):
    url = f"https://api.github.com/repos/{repository}/{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    last_error = None
    for attempt in range(1, 5):
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1200]
            last_error = RuntimeError(f"GitHub API {method} {path}: HTTP {exc.code}: {detail}")
            if exc.code < 500 or attempt == 4:
                raise last_error from exc
            time.sleep(attempt * 2)
        except Exception as exc:
            last_error = exc
            if attempt == 4:
                raise
            time.sleep(attempt * 2)
    raise last_error or RuntimeError("Errore GitHub API")

ref = api("GET", f"git/ref/heads/{urllib.parse.quote(branch, safe='')}")
head_sha = ref["object"]["sha"]
head_commit = api("GET", f"git/commits/{head_sha}")
base_tree_sha = head_commit["tree"]["sha"]
print(f"HEAD iniziale: {head_sha}")

tree_entries = []
for rel in files:
    local = root / rel
    if not local.is_file():
        raise FileNotFoundError(local)
    blob = api("POST", "git/blobs", {
        "content": base64.b64encode(local.read_bytes()).decode("ascii"),
        "encoding": "base64",
    })
    tree_entries.append({
        "path": rel,
        "mode": "100644",
        "type": "blob",
        "sha": blob["sha"],
    })
    print(f"Blob pronto: {rel}")

tree_entries.append({
    "path": old_guide,
    "mode": "100644",
    "type": "blob",
    "sha": None,
})

tree = api("POST", "git/trees", {
    "base_tree": base_tree_sha,
    "tree": tree_entries,
})
commit = api("POST", "git/commits", {
    "message": "Automatizza flussi registratore 3.5.3",
    "tree": tree["sha"],
    "parents": [head_sha],
})
new_sha = commit["sha"]
print(f"Commit preparato: {new_sha}")

api("PATCH", f"git/refs/heads/{urllib.parse.quote(branch, safe='')}", {
    "sha": new_sha,
    "force": False,
})
print(f"Pubblicazione 3.5.3 completata: {new_sha}")
