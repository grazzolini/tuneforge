import json
from fractions import Fraction
from typing import Any

def _decode_metadata_json(value: str, field: str) -> Any:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Demucs safetensors {field} metadata is not valid JSON.") from exc
    return _decode_json(decoded)

def _decode_json(value: Any) -> Any:
    if isinstance(value, dict):
        if "_type" in value:
            if set(value) != {"_type", "numerator", "denominator"} or value["_type"] != "fraction":
                raise ValueError("Unsupported Demucs safetensors structured value.")
            numerator = value["numerator"]
            denominator = value["denominator"]
            if (
                not isinstance(numerator, int)
                or isinstance(numerator, bool)
                or not isinstance(denominator, int)
                or isinstance(denominator, bool)
                or denominator == 0
            ):
                raise ValueError("Demucs safetensors fraction must contain integer values.")
            return Fraction(numerator, denominator)
        return {key: _decode_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_json(item) for item in value]
    return value
