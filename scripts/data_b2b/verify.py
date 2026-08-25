"""Entry point: `python -m scripts.data_b2b.verify` (wired as `npm run data:verify:b2b`)."""
import sys

from .manifest import verify_manifest


def main() -> int:
    ok, problems = verify_manifest()
    if ok:
        print("data:verify:b2b — every file matches the manifest")
        return 0
    print("data:verify:b2b FAILED:")
    for p in problems:
        print(f"  - {p}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
