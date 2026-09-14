from __future__ import annotations

from fractions import Fraction
from importlib import metadata
from pathlib import Path

import pytest
import torch
from safetensors.torch import save_file

from app.engines import demucs_safetensors


class FakeHTDemucs(torch.nn.Module):
    def __init__(self, *, segment: Fraction, enabled: bool = True) -> None:
        super().__init__()
        self.weight = torch.nn.Parameter(torch.zeros(2))
        self.segment = segment
        self.enabled = enabled


def test_runtime_uses_pinned_demucs_infer_distribution() -> None:
    assert metadata.version("demucs-infer") == "4.2.2"
    with pytest.raises(metadata.PackageNotFoundError):
        metadata.distribution("demucs")


def test_decode_json_preserves_primitives_and_decodes_nested_fraction() -> None:
    assert demucs_safetensors._decode_json(
        {"values": [None, True, 3, 1.5, "text", {"_type": "fraction", "numerator": 39, "denominator": 5}]}
    ) == {"values": [None, True, 3, 1.5, "text", Fraction(39, 5)]}


@pytest.mark.parametrize(
    "value",
    [
        {"_type": "class", "name": "anything"},
        {"_type": "fraction", "numerator": 1, "denominator": 0},
        {"_type": "fraction", "numerator": True, "denominator": 2},
        {"_type": "fraction", "numerator": 1, "denominator": 2, "extra": 3},
    ],
)
def test_decode_json_rejects_unsupported_structures(value: object) -> None:
    with pytest.raises(ValueError):
        demucs_safetensors._decode_json(value)


def test_load_safetensors_model_constructs_native_class_and_loads_strict_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(demucs_safetensors, "HTDemucs", FakeHTDemucs)
    path = _write_model(tmp_path)

    model = demucs_safetensors.load_safetensors_model(path)

    assert isinstance(model, FakeHTDemucs)
    assert model.segment == Fraction(39, 5)
    assert model.enabled is True
    assert torch.equal(model.weight, torch.tensor([1.0, 2.0]))


@pytest.mark.parametrize(
    ("metadata_overrides", "expected"),
    [
        ({"klass": "other.module.Model"}, "Unsupported Demucs safetensors model class"),
        ({"structure": "{}"}, "Unsupported Demucs safetensors metadata fields"),
        ({"args": "{}"}, "args metadata must be a JSON list"),
        ({"kwargs": "[]"}, "kwargs metadata must be a JSON object"),
        ({"kwargs": "not-json"}, "kwargs metadata is not valid JSON"),
    ],
)
def test_load_safetensors_model_rejects_unsupported_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    metadata_overrides: dict[str, str],
    expected: str,
) -> None:
    monkeypatch.setattr(demucs_safetensors, "HTDemucs", FakeHTDemucs)
    path = _write_model(tmp_path, metadata_overrides=metadata_overrides)

    with pytest.raises(ValueError, match=expected):
        demucs_safetensors.load_safetensors_model(path)


def test_load_safetensors_model_keeps_constructor_strict(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(demucs_safetensors, "HTDemucs", FakeHTDemucs)
    path = _write_model(tmp_path, metadata_overrides={"kwargs": '{"unexpected": true}'})

    with pytest.raises(TypeError, match="unexpected"):
        demucs_safetensors.load_safetensors_model(path)


def test_load_safetensors_model_keeps_tensor_keys_strict(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(demucs_safetensors, "HTDemucs", FakeHTDemucs)
    path = _write_model(tmp_path, tensors={"unexpected": torch.ones(2)})

    with pytest.raises(RuntimeError, match=r"(?s)Missing key.*Unexpected key"):
        demucs_safetensors.load_safetensors_model(path)


def _write_model(
    tmp_path: Path,
    *,
    metadata_overrides: dict[str, str] | None = None,
    tensors: dict[str, torch.Tensor] | None = None,
) -> Path:
    model_metadata = {
        "klass": "demucs.htdemucs.HTDemucs",
        "args": "[]",
        "kwargs": '{"segment":{"_type":"fraction","numerator":39,"denominator":5}}',
        **(metadata_overrides or {}),
    }
    path = tmp_path / "model.safetensors"
    save_file(tensors or {"weight": torch.tensor([1.0, 2.0])}, path, metadata=model_metadata)
    return path
