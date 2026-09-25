from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.cli import prepare_model_bundle as bundle_cli
from app.services import drum_substem_model
from app.utils import model_bundle
from app.utils.hashing import file_sha256


def _descriptor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    payload = tmp_path / "verified.safetensors"
    payload.write_bytes(b"synthetic verified safetensors fixture")
    descriptor = tmp_path / "drumsep-model.json"
    descriptor.write_text(json.dumps({
        "id": "drumsep", "class": "demucs.hdemucs.HDemucs",
        "repo_id": "reviewed/drumsep", "revision": "a" * 40,
        "file_name": "drumsep.safetensors", "sha256": file_sha256(payload),
        "size_bytes": payload.stat().st_size, "license": "MIT",
        "rights_record": "https://example.org/rights",
    }))
    monkeypatch.setattr(drum_substem_model, "_manifest_path", lambda: descriptor)
    monkeypatch.setattr(bundle_cli, "_prepare_demucs_entries", lambda _output: [])
    monkeypatch.setattr(bundle_cli, "_prepare_whisper_entries", lambda _output, _models: [])
    return descriptor, payload


def _prepare(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    descriptor, payload = _descriptor(tmp_path, monkeypatch)
    checkpoint = drum_substem_model.read_drumsep_checkpoint()
    assert checkpoint is not None
    monkeypatch.setattr(bundle_cli, "resolve_drumsep_checkpoint", lambda **_kwargs: (checkpoint, payload))
    bundle = tmp_path / "bundle"
    bundle_cli.prepare_model_bundle(output_dir=bundle, lyrics_models=[])
    return descriptor, payload, bundle


def test_model_bundle_without_drumsep_descriptor_stays_compatible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(drum_substem_model, "_manifest_path", lambda: tmp_path / "missing.json")
    monkeypatch.setattr(bundle_cli, "_prepare_demucs_entries", lambda _output: [])
    monkeypatch.setattr(bundle_cli, "_prepare_whisper_entries", lambda _output, _models: [])
    bundle = tmp_path / "bundle"
    bundle_cli.prepare_model_bundle(output_dir=bundle, lyrics_models=[])
    assert "drumsep_checkpoint" not in json.loads((bundle / "manifest.json").read_text())
    assert model_bundle.demucs_model_bundle_repo(bundle) is None


def test_model_bundle_includes_verified_drumsep_and_reuses_it_offline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _descriptor_path, _payload, bundle = _prepare(tmp_path, monkeypatch)
    manifest = json.loads((bundle / "manifest.json").read_text())
    checkpoint = drum_substem_model.read_drumsep_checkpoint()
    assert checkpoint is not None
    relative = f"demucs/drumsep/{checkpoint.revision}/drumsep.safetensors"
    assert manifest["drumsep_checkpoint"] == {
        "id": "drumsep", "class": "demucs.hdemucs.HDemucs",
        "repo_id": checkpoint.repo_id, "revision": checkpoint.revision,
        "file_name": checkpoint.file_name, "sha256": checkpoint.sha256,
        "size_bytes": checkpoint.size_bytes, "license": "MIT",
        "rights_record": checkpoint.rights_record, "relative_path": relative,
    }
    assert model_bundle.demucs_model_bundle_repo(bundle) == bundle / "demucs"
    monkeypatch.setattr(drum_substem_model, "configured_stem_model_repo", lambda: bundle / "demucs")
    monkeypatch.setattr(
        drum_substem_model, "hf_hub_download", lambda *_args, **_kwargs: pytest.fail("network used")
    )
    resolved, path = drum_substem_model.resolve_drumsep_checkpoint(allow_download=False)
    assert resolved == checkpoint and path == bundle / relative
    assert drum_substem_model.resolve_drumsep_checkpoint(allow_download=True)[1] == path


@pytest.mark.parametrize("damage", ["missing", "corrupt", "metadata", "extra", "no_descriptor"])
def test_model_bundle_rejects_invalid_or_unexpected_drumsep_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str,
) -> None:
    descriptor, _payload, bundle = _prepare(tmp_path, monkeypatch)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    asset = bundle / manifest["drumsep_checkpoint"]["relative_path"]
    if damage == "missing":
        asset.unlink()
    elif damage == "corrupt":
        asset.write_bytes(b"corrupt")
    elif damage == "metadata":
        manifest["drumsep_checkpoint"]["sha256"] = "0" * 64
        manifest_path.write_text(json.dumps(manifest))
    elif damage == "extra":
        (asset.parent / "unexpected.safetensors").write_bytes(b"unapproved")
    else:
        descriptor.unlink()
    with pytest.raises(RuntimeError, match="DrumSep"):
        model_bundle.demucs_model_bundle_repo(bundle)


def test_model_bundle_rejects_unlisted_or_null_drumsep_entry_and_invalid_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor, _payload, bundle = _prepare(tmp_path, monkeypatch)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["drumsep_checkpoint"]
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(RuntimeError, match="unlisted DrumSep"):
        model_bundle.demucs_model_bundle_repo(bundle)
    (bundle / "demucs").rename(tmp_path / "removed-demucs")
    manifest["drumsep_checkpoint"] = None
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(RuntimeError, match="DrumSep metadata"):
        model_bundle.demucs_model_bundle_repo(bundle)
    descriptor.write_text(descriptor.read_text().replace("https://example.org/rights", ""))
    with pytest.raises(RuntimeError, match="provenance or rights"):
        bundle_cli.prepare_model_bundle(output_dir=tmp_path / "invalid", lyrics_models=[])
