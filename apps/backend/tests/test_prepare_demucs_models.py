from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.cli import prepare_demucs_models
from app.engines.demucs_cache import InvalidDemucsHfCacheFile
from app.utils.model_cache import ExpectedModelFile


def test_prepare_demucs_model_repo_copies_verified_files_before_replacing_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "hf" / "model-a.yaml"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"models: ['sig-a']\n")
    safetensors = tmp_path / "hf" / "sig-a.safetensors"
    safetensors.write_bytes(b"safe-model")
    revision = "a" * 40
    files = tuple(
        ExpectedModelFile(
            label=name,
            path=path,
            size=path.stat().st_size,
            sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        )
        for name, path in (("yaml", source), ("model", safetensors))
    )
    model = SimpleNamespace(id="model-a", revision=revision)
    output = tmp_path / "repo"
    output.mkdir()
    (output / "previous.txt").write_text("preserve until validation", encoding="utf-8")
    cache_dir = tmp_path / "explicit-cache"
    calls: list[object] = []

    monkeypatch.setattr(
        prepare_demucs_models,
        "preload_demucs_hf_cache",
        lambda **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(prepare_demucs_models, "read_demucs_hf_models", lambda _manifest: (model,))
    monkeypatch.setattr(
        prepare_demucs_models,
        "resolved_demucs_hf_cache_files",
        lambda _model_id, **_kwargs: files,
    )

    def validate(staging_root: Path, model_id: str, **_kwargs: object) -> tuple[Path, ...]:
        assert model_id == "model-a"
        assert (output / "previous.txt").is_file()
        assert (staging_root / "model-a" / revision / "model-a.yaml").read_bytes() == source.read_bytes()
        assert (staging_root / "model-a" / revision / "sig-a.safetensors").read_bytes() == safetensors.read_bytes()
        return ()

    monkeypatch.setattr(prepare_demucs_models, "validate_demucs_model_repo", validate)

    prepare_demucs_models.prepare_demucs_model_repo(output, cache_dir=cache_dir)

    assert calls == [{"manifest_path": None, "cache_dir": cache_dir}]
    assert not (output / "previous.txt").exists()
    assert (output / "model-a" / revision / "model-a.yaml").read_bytes() == source.read_bytes()
    assert (output / "model-a" / revision / "sig-a.safetensors").read_bytes() == safetensors.read_bytes()


def test_prepare_demucs_model_repo_cache_only_fails_without_network(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    invalid = InvalidDemucsHfCacheFile("model-a", "model-a.yaml", "missing", None)
    calls: list[str] = []
    monkeypatch.setattr(
        prepare_demucs_models,
        "invalid_demucs_hf_cache_files",
        lambda **_kwargs: (invalid,),
    )
    monkeypatch.setattr(
        prepare_demucs_models,
        "preload_demucs_hf_cache",
        lambda **_kwargs: calls.append("network"),
    )

    with pytest.raises(RuntimeError, match="cache-only preparation requires valid cached files"):
        prepare_demucs_models.prepare_demucs_model_repo(tmp_path / "repo", cache_only=True)

    assert calls == []


def test_prepare_demucs_cli_defaults_and_explicit_cache(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[Path, Path | None, bool]] = []
    monkeypatch.setattr(
        prepare_demucs_models,
        "prepare_demucs_model_repo",
        lambda output, *, cache_dir, cache_only: calls.append((output, cache_dir, cache_only)),
    )
    monkeypatch.delenv("TUNEFORGE_DEMUCS_CACHE_ONLY", raising=False)
    monkeypatch.delenv("TUNEFORGE_DEMUCS_PREPARE_BASE_DIR", raising=False)

    assert prepare_demucs_models.main([]) == 0
    assert calls == [(prepare_demucs_models.default_prepared_demucs_model_repo_path(), None, False)]

    output = tmp_path / "repo"
    cache = tmp_path / "hf-cache"
    assert prepare_demucs_models.main(["--output", str(output), "--cache", str(cache), "--cache-only"]) == 0
    assert calls[-1] == (output, cache, True)


def test_prepare_demucs_cli_resolves_relative_paths_from_package_base_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[Path, Path | None, bool]] = []
    monkeypatch.setattr(
        prepare_demucs_models,
        "prepare_demucs_model_repo",
        lambda output, *, cache_dir, cache_only: calls.append((output, cache_dir, cache_only)),
    )
    base_dir = tmp_path / "invocation"
    monkeypatch.setenv("TUNEFORGE_DEMUCS_PREPARE_BASE_DIR", str(base_dir))

    assert prepare_demucs_models.main(["--output", "repo", "--cache", "hf-cache"]) == 0
    assert calls == [(base_dir / "repo", base_dir / "hf-cache", False)]

    absolute_output = tmp_path / "absolute-repo"
    absolute_cache = tmp_path / "absolute-cache"
    assert prepare_demucs_models.main(["--output", str(absolute_output), "--cache", str(absolute_cache)]) == 0
    assert calls[-1] == (absolute_output, absolute_cache, False)

    assert prepare_demucs_models.main([]) == 0
    assert calls[-1] == (prepare_demucs_models.default_prepared_demucs_model_repo_path(), None, False)
