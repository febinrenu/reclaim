"""Entry point: `python -m scripts.data.verify` (wired as `npm run data:verify`).

Re-hashes every file the manifest lists and exits non-zero on any mismatch, printing
exactly which files and dimension (hash vs size) disagree. Does not regenerate
anything — it is a pure check of what is already on disk against what the manifest
says should be there.
"""
import sys

from .manifest import verify_manifest


def main() -> int:
    ok, problems = verify_manifest()
    if ok:
        print("data:verify — every file matches the manifest")
        return 0
    print("data:verify FAILED:")
    for p in problems:
        print(f"  - {p}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
