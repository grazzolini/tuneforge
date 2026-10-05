from __future__ import annotations

import json
import sys
from pathlib import Path

_PROFILE = json.loads(Path(__file__).with_name("storage-profile.json").read_text())


def default_data_root(home: Path | None = None, platform: str | None = None) -> Path:
    return (home or Path.home()) / _PROFILE["backend"].get(platform or sys.platform, _PROFILE["backend"]["linux"])


def default_model_cache_root() -> Path:
    return Path.home() / _PROFILE["modelCache"]
