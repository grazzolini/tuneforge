#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo_root / "apps" / "backend"))

    from app.benchmarks.timing import main as timing_main

    return timing_main()


if __name__ == "__main__":
    raise SystemExit(main())
