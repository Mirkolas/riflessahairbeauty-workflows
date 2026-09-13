from __future__ import annotations

import base64
import json
import os
import sys
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


def api(method: str, path: str, body: dict | None = None, allow_404: bool = False):
    url = f"https://api.github.com/repos/{repository}/{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as exc:
        if allow_404 and exc.code == 404:
            return None
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"GitHub API {method} {path}: HTTP {exc.code}: {detail}") from exc


def content_path(rel: str) -> str:
    return "contents/" + urllib.parse.quote(rel, safe="/")


def remote_sha(rel: str) -> str | None:
    encoded_branch = urllib.parse.quote(branch, safe="")
    out = api("GET", f"{content_path(rel)}?ref={encoded_branch}", allow_404=True)
    return out.get("sha") if out else None


def upsert(rel: str):
    local = root / rel
    if not local.is_file():
        raise FileNotFoundError(local)
    sha = remote_sha(rel)
    body = {
        "message": f"Automatizza registratore 3.5.3: {rel}",
        "content": base64.b64encode(local.read_bytes()).decode("ascii"),
        "branch": branch,
    }
    if sha:
        body["sha"] = sha
    api("PUT", content_path(rel), body)
    print(f"Pubblicato: {rel}")


def delete_if_exists(rel: str):
    sha = remote_sha(rel)
    if not sha:
        return
    api("DELETE", content_path(rel), {
        "message": "Aggiorna guida registratore 3.5.3",
        "sha": sha,
        "branch": branch,
    })
    print(f"Eliminato: {rel}")


for rel in files[:-2]:
    upsert(rel)

delete_if_exists(old_guide)
upsert(files[-2])
upsert(files[-1])
print("Pubblicazione 3.5.3 completata")
