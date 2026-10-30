"""Transport for the versioned, local TuneForge music core."""

import json
from collections.abc import Mapping
from typing import Any

from . import _native

__version__ = "0.1.0"
API_VERSION = _native.api_version()
ABI_VERSION = _native.abi_version()
SCHEMA_VERSION = _native.schema_version()
CORPUS_VERSION = _native.corpus_version()
if (API_VERSION, ABI_VERSION, SCHEMA_VERSION, CORPUS_VERSION) != (1, 1, 1, 1):
    raise ImportError("Incompatible TuneForge music-core contract")


def call(request: Mapping[str, Any]) -> Any:
    """Pass one named operation DTO to the shared implementation."""
    encoded = json.dumps({"apiVersion": API_VERSION, "schemaVersion": SCHEMA_VERSION, **request}, allow_nan=False)
    response = json.loads(_native.call_json(encoded))
    if response.get("apiVersion") != API_VERSION or response.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeError("Incompatible TuneForge music-core response")
    if response.get("operation") != request.get("operation"):
        raise RuntimeError("Mismatched TuneForge music-core response")
    return response["result"]
