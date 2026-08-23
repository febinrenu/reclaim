"""
The seeded manifest (BUILD_PLAN.md §1.4 addition 4): a reviewer regenerates our exact
demo data from the committed seed, and `data:verify` proves it byte-for-byte rather
than by eye. Hashing is over the file's actual bytes, so any change to content,
column order, or even line-ending discipline is caught.
"""
import hashlib
import json
from pathlib import Path

from .common import SEED, OUT_DIR


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(files: list[Path], summary: dict) -> Path:
    manifest = {
        "seed": SEED,
        "files": {
            str(p.relative_to(OUT_DIR)): {"sha256": sha256_of(p), "bytes": p.stat().st_size}
            for p in sorted(files)
        },
        "summary": summary,
    }
    manifest_path = OUT_DIR / "manifest.json"
    # newline="\n": Path.write_text() otherwise translates "\n" to os.linesep on
    # write, which is CRLF on Windows — see generate.py's matching lineterminator
    # note. The manifest must be LF on disk before hashing anything else, since
    # data:verify re-hashes this file's own bytes too.
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8", newline="\n"
    )
    return manifest_path


def verify_manifest() -> tuple[bool, list[str]]:
    manifest_path = OUT_DIR / "manifest.json"
    if not manifest_path.exists():
        return False, [f"no manifest at {manifest_path} — run `npm run data:generate` first"]

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    problems = []
    for rel, expected in manifest["files"].items():
        path = OUT_DIR / rel
        if not path.exists():
            problems.append(f"missing file: {rel}")
            continue
        actual_hash = sha256_of(path)
        if actual_hash != expected["sha256"]:
            problems.append(f"hash mismatch: {rel} (expected {expected['sha256'][:12]}…, got {actual_hash[:12]}…)")
        actual_bytes = path.stat().st_size
        if actual_bytes != expected["bytes"]:
            problems.append(f"size mismatch: {rel} (expected {expected['bytes']} bytes, got {actual_bytes})")
    return len(problems) == 0, problems
