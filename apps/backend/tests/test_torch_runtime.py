from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.utils.torch_runtime import choose_torch_device


def make_fake_torch(
    *,
    has_mps: bool,
    has_cuda: bool,
    supported_arches: list[str] | None = None,
    device_capability: tuple[int, int] = (7, 5),
):
    return SimpleNamespace(
        version=SimpleNamespace(cuda="13.0" if has_cuda else None),
        backends=SimpleNamespace(
            mps=SimpleNamespace(
                is_available=lambda: has_mps,
            )
        ),
        cuda=SimpleNamespace(
            is_available=lambda: has_cuda,
            get_arch_list=lambda: list(supported_arches or []),
            device_count=lambda: 1 if has_cuda else 0,
            get_device_capability=lambda _index: device_capability,
        ),
    )


def test_choose_torch_device_prefers_cuda_then_mps_then_cpu():
    assert choose_torch_device(
        "auto",
        torch_module=make_fake_torch(
            has_mps=True,
            has_cuda=True,
            supported_arches=["sm_75", "sm_80"],
            device_capability=(7, 5),
        ),
    ) == "cuda"
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=True, has_cuda=False)) == "mps"
    assert choose_torch_device("auto", torch_module=make_fake_torch(has_mps=False, has_cuda=False)) == "cpu"


def test_choose_torch_device_rejects_unavailable_requested_backend():
    with pytest.raises(RuntimeError, match="MPS is unavailable"):
        choose_torch_device("mps", torch_module=make_fake_torch(has_mps=False, has_cuda=False))

    with pytest.raises(RuntimeError, match="CUDA is unavailable"):
        choose_torch_device("cuda", torch_module=make_fake_torch(has_mps=True, has_cuda=False))


def test_choose_torch_device_auto_falls_back_when_cuda_arch_is_unsupported():
    assert (
        choose_torch_device(
            "auto",
            torch_module=make_fake_torch(
                has_mps=False,
                has_cuda=True,
                supported_arches=["sm_75", "sm_80"],
                device_capability=(6, 1),
            ),
        )
        == "cpu"
    )


def test_lv_chordia_uses_architecture_aware_torch_device(monkeypatch: pytest.MonkeyPatch):
    from app.engines import lv_chordia

    fake_torch = make_fake_torch(
        has_mps=False,
        has_cuda=True,
        supported_arches=["sm_75", "sm_80"],
        device_capability=(6, 1),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    assert lv_chordia.lv_chordia_runtime_device() == "cpu"


def test_lv_chordia_prewarm_retries_recognized_accelerator_failure_on_cpu(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.engines import lv_chordia

    calls: list[str] = []

    def fake_session_for_device(device: str) -> object:
        calls.append(device)
        if device == "mps":
            raise RuntimeError("MPS backend out of memory")
        return object()

    monkeypatch.setattr(lv_chordia, "lv_chordia_runtime_device", lambda: "mps")
    monkeypatch.setattr(lv_chordia, "_session_for_device", fake_session_for_device)

    lv_chordia.preload_lv_chordia_session()

    assert calls == ["mps", "cpu"]


def test_lv_chordia_prewarm_propagates_unrecognized_failure_without_cpu_retry(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.engines import lv_chordia

    calls: list[str] = []
    original_error = RuntimeError("LV Chordia checkpoint is corrupt")

    def fake_session_for_device(device: str) -> object:
        calls.append(device)
        raise original_error

    monkeypatch.setattr(lv_chordia, "lv_chordia_runtime_device", lambda: "cuda")
    monkeypatch.setattr(lv_chordia, "_session_for_device", fake_session_for_device)

    with pytest.raises(RuntimeError) as exc_info:
        lv_chordia.preload_lv_chordia_session()

    assert exc_info.value is original_error
    assert calls == ["cuda"]


def test_choose_torch_device_rejects_requested_cuda_when_arch_is_unsupported():
    with pytest.raises(RuntimeError, match="does not support the visible NVIDIA GPU architecture"):
        choose_torch_device(
            "cuda",
            torch_module=make_fake_torch(
                has_mps=False,
                has_cuda=True,
                supported_arches=["sm_75", "sm_80"],
                device_capability=(6, 1),
            ),
        )


def test_choose_torch_device_rejects_unknown_backend():
    with pytest.raises(ValueError, match="Unsupported torch device"):
        choose_torch_device("metal", torch_module=make_fake_torch(has_mps=True, has_cuda=False))


def test_demucs_manifest_pins_exact_hugging_face_models():
    from app.engines.demucs_cache import read_demucs_hf_models

    models = read_demucs_hf_models()

    assert [(model.id, model.repo_id, model.revision, model.bag_order) for model in models] == [
        (
            "htdemucs_6s",
            "adefossez/HTDemucs-6s",
            "053e1404489b3dc58bf718224fac4b7316de8c93",
            ("5c90dfd2",),
        ),
        (
            "htdemucs_ft",
            "adefossez/HTDemucs-ft",
            "478be8a68f85418addd6f7baefd4be76522a4034",
            ("f7e0c4bc", "d12395a8", "92cfc3b6", "04573f0d"),
        ),
    ]
    assert all(file.file_name.endswith((".yaml", ".safetensors")) for model in models for file in model.files)


def test_packaged_demucs_manifest_resolves_from_backend_source_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines import demucs_cache

    module_path = tmp_path / "backend" / "src" / "app" / "engines" / "demucs_cache.py"
    packaged_manifest = tmp_path / "backend" / "src" / "demucs-models.json"
    packaged_manifest.parent.mkdir(parents=True)
    packaged_manifest.write_text('{"version": 2, "models": []}', encoding="utf-8")
    monkeypatch.setattr(demucs_cache, "__file__", str(module_path))

    assert demucs_cache.default_demucs_model_manifest_path() == packaged_manifest


@pytest.mark.parametrize("mutation, expected", [
    ("duplicate", "duplicate model id"),
    ("traversal", "invalid file name"),
])
def test_demucs_manifest_rejects_duplicates_and_path_traversal(
    tmp_path: Path,
    mutation: str,
    expected: str,
):
    from app.engines.demucs_cache import read_demucs_hf_models

    manifest_path, _payloads = _write_hf_demucs_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text())
    if mutation == "duplicate":
        manifest["models"].append(dict(manifest["models"][0]))
    else:
        manifest["models"][0]["files"][0]["file_name"] = "../model-a.yaml"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(RuntimeError, match=expected):
        read_demucs_hf_models(manifest_path, model_ids=("model-a",))


@pytest.mark.parametrize("model_id", ["../escape", "/absolute", "nested/id", "nested\\id", ".", ".."])
def test_demucs_manifest_rejects_unsafe_model_ids(tmp_path: Path, model_id: str):
    from app.engines.demucs_cache import read_demucs_hf_models

    manifest_path, _payloads = _write_hf_demucs_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text())
    manifest["models"][0]["id"] = model_id
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(RuntimeError, match="invalid model id"):
        read_demucs_hf_models(manifest_path, model_ids=(model_id,))


def test_demucs_hf_prewarm_downloads_missing_files_and_warm_cache_skips_network(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines import demucs_cache

    manifest_path, payloads = _write_hf_demucs_manifest(tmp_path)
    cache_dir = tmp_path / "hf-cache"
    calls: list[tuple[str, str, str, bool, Path]] = []

    def fake_try(repo_id: str, filename: str, *, revision: str, cache_dir: Path) -> str | object:
        del repo_id, revision
        path = cache_dir / filename
        return str(path) if path.is_file() else object()

    def fake_download(
        repo_id: str,
        filename: str,
        *,
        revision: str,
        cache_dir: Path,
        force_download: bool,
    ) -> str:
        calls.append((repo_id, filename, revision, force_download, cache_dir))
        path = cache_dir / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payloads[filename])
        return str(path)

    monkeypatch.setattr(demucs_cache, "try_to_load_from_cache", fake_try)
    monkeypatch.setattr(demucs_cache, "hf_hub_download", fake_download)

    cold = demucs_cache.preload_demucs_hf_cache(
        model_ids=("model-a",), manifest_path=manifest_path, cache_dir=cache_dir
    )
    warm = demucs_cache.preload_demucs_hf_cache(
        model_ids=("model-a",), manifest_path=manifest_path, cache_dir=cache_dir
    )

    assert [result.cache_hit for result in cold] == [False]
    assert [result.cache_hit for result in warm] == [True]
    assert calls == [
        ("fixture/model-a", "model-a.yaml", "a" * 40, False, cache_dir),
        ("fixture/model-a", "sig-a.safetensors", "a" * 40, False, cache_dir),
    ]


def test_demucs_hf_prewarm_force_repairs_only_corrupt_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines import demucs_cache

    manifest_path, payloads = _write_hf_demucs_manifest(tmp_path)
    cache_dir = tmp_path / "hf-cache"
    cache_dir.mkdir()
    (cache_dir / "model-a.yaml").write_bytes(payloads["model-a.yaml"])
    (cache_dir / "sig-a.safetensors").write_bytes(b"corrupt")
    calls: list[tuple[str, bool]] = []

    monkeypatch.setattr(
        demucs_cache,
        "try_to_load_from_cache",
        lambda _repo, filename, **_kwargs: str(cache_dir / filename),
    )

    def fake_download(_repo: str, filename: str, *, force_download: bool, **_kwargs: object) -> str:
        calls.append((filename, force_download))
        (cache_dir / filename).write_bytes(payloads[filename])
        return str(cache_dir / filename)

    monkeypatch.setattr(demucs_cache, "hf_hub_download", fake_download)

    demucs_cache.preload_demucs_hf_cache(
        model_ids=("model-a",), manifest_path=manifest_path, cache_dir=cache_dir
    )

    assert calls == [("sig-a.safetensors", True)]


def test_demucs_hf_default_cache_uses_hugging_face_defaults_without_cache_keyword(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines import demucs_cache

    manifest_path, payloads = _write_hf_demucs_manifest(tmp_path)
    cached_paths: dict[str, Path] = {}
    cache_call_options: list[dict[str, object]] = []
    download_call_options: list[dict[str, object]] = []

    def fake_try(_repo_id: str, filename: str, **options: object) -> str | object:
        cache_call_options.append(options)
        path = cached_paths.get(filename)
        return str(path) if path else object()

    def fake_download(_repo_id: str, filename: str, **options: object) -> str:
        download_call_options.append(options)
        path = tmp_path / filename
        path.write_bytes(payloads[filename])
        cached_paths[filename] = path
        return str(path)

    monkeypatch.setattr(demucs_cache, "try_to_load_from_cache", fake_try)
    monkeypatch.setattr(demucs_cache, "hf_hub_download", fake_download)

    result = demucs_cache.preload_demucs_hf_cache(model_ids=("model-a",), manifest_path=manifest_path)

    assert result == (demucs_cache.DemucsPreloadResult(model_id="model-a", cache_hit=False),)
    assert all("cache_dir" not in options for options in cache_call_options)
    assert all("cache_dir" not in options for options in download_call_options)


@pytest.mark.parametrize(
    ("overrides", "relative_cache"),
    [
        ({}, ".cache/huggingface/hub"),
        ({"XDG_CACHE_HOME": "xdg"}, "xdg/huggingface/hub"),
        ({"HF_HOME": "hf-home", "XDG_CACHE_HOME": "xdg"}, "hf-home/hub"),
        (
            {"HUGGINGFACE_HUB_CACHE": "legacy", "HF_HOME": "hf-home", "XDG_CACHE_HOME": "xdg"},
            "legacy",
        ),
        (
            {
                "HF_HUB_CACHE": "hub",
                "HUGGINGFACE_HUB_CACHE": "legacy",
                "HF_HOME": "hf-home",
                "XDG_CACHE_HOME": "xdg",
            },
            "hub",
        ),
    ],
)
def test_hugging_face_cache_environment_precedence_is_resolved_at_import_time(
    tmp_path: Path,
    overrides: dict[str, str],
    relative_cache: str,
):
    environment = dict(os.environ)
    for name in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_HOME", "XDG_CACHE_HOME"):
        environment.pop(name, None)
    home = tmp_path / "home"
    environment["HOME"] = str(home)
    environment.update({name: str(tmp_path / value) for name, value in overrides.items()})
    if "XDG_CACHE_HOME" in overrides:
        relative_cache = relative_cache.replace("xdg", str(tmp_path / "xdg"), 1)
    if "HF_HOME" in overrides:
        relative_cache = relative_cache.replace("hf-home", str(tmp_path / "hf-home"), 1)
    if "HF_HUB_CACHE" in overrides:
        relative_cache = relative_cache.replace("hub", str(tmp_path / "hub"), 1)
    if "HUGGINGFACE_HUB_CACHE" in overrides:
        relative_cache = relative_cache.replace("legacy", str(tmp_path / "legacy"), 1)
    expected = home / relative_cache if not Path(relative_cache).is_absolute() else Path(relative_cache)
    completed = subprocess.run(
        [sys.executable, "-c", "from huggingface_hub import constants; print(constants.HF_HUB_CACHE)"],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    assert Path(completed.stdout.strip()) == expected


def test_demucs_local_repo_uses_pinned_layout_and_rejects_legacy_th(tmp_path: Path):
    from app.engines.demucs_cache import LEGACY_DEMUCS_MIGRATION, validate_demucs_model_repo

    manifest_path, payloads = _write_hf_demucs_manifest(tmp_path)
    repo = tmp_path / "repo"
    model_root = repo / "model-a" / ("a" * 40)
    model_root.mkdir(parents=True)
    for name, payload in payloads.items():
        (model_root / name).write_bytes(payload)

    paths = validate_demucs_model_repo(repo, "model-a", manifest_path=manifest_path)
    assert [path.name for path in paths] == ["model-a.yaml", "sig-a.safetensors"]

    (repo / "old.th").write_bytes(b"legacy")
    with pytest.raises(RuntimeError, match="recreate using current TuneForge") as exc_info:
        validate_demucs_model_repo(repo, "model-a", manifest_path=manifest_path)
    assert str(exc_info.value) == LEGACY_DEMUCS_MIGRATION


def test_demucs_adapter_loads_local_safetensors_in_bag_order(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from demucs import apply as demucs_apply
    from demucs import hf as demucs_hf

    from app.engines.demucs_cache import load_demucs_model

    manifest_path, payloads = _write_hf_demucs_manifest(tmp_path)
    repo = tmp_path / "repo"
    model_root = repo / "model-a" / ("a" * 40)
    model_root.mkdir(parents=True)
    for name, payload in payloads.items():
        (model_root / name).write_bytes(payload)

    loaded_paths: list[Path] = []
    monkeypatch.setattr(
        demucs_hf,
        "load_safetensors_model",
        lambda path: loaded_paths.append(Path(path)) or SimpleNamespace(),
    )

    class FakeBag:
        def __init__(self, models, weights, segment):
            self.models = models
            self.weights = weights
            self.segment = segment
            self.evaluated = False

        def eval(self):
            self.evaluated = True
            return self

    monkeypatch.setattr(demucs_apply, "BagOfModels", FakeBag)

    loaded = load_demucs_model("model-a", model_repo=repo, manifest_path=manifest_path)

    assert loaded_paths == [model_root / "sig-a.safetensors"]
    assert loaded.evaluated is True


def test_model_cache_verification_accepts_valid_files(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    path = tmp_path / "model.bin"
    path.write_bytes(b"model")

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=path,
                size=5,
                sha256=hashlib.sha256(b"model").hexdigest(),
            ),
        ),
    )

    assert invalid_files == ()


def test_model_cache_verification_rejects_missing_files(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=tmp_path / "missing.bin",
                size=5,
                sha256=hashlib.sha256(b"model").hexdigest(),
            ),
        ),
    )

    assert invalid_files[0].reason == "missing"


def test_model_cache_verification_rejects_wrong_size(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    path = tmp_path / "model.bin"
    path.write_bytes(b"model")

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=path,
                size=6,
                sha256=hashlib.sha256(b"model").hexdigest(),
            ),
        ),
    )

    assert invalid_files[0].reason == "size"


def test_model_cache_verification_rejects_wrong_hash(tmp_path: Path):
    from app.utils.model_cache import ExpectedModelFile, invalid_model_files

    path = tmp_path / "model.bin"
    path.write_bytes(b"model")

    invalid_files = invalid_model_files(
        (
            ExpectedModelFile(
                label="fixture model",
                path=path,
                size=5,
                sha256=hashlib.sha256(b"other").hexdigest(),
            ),
        ),
    )

    assert invalid_files[0].reason == "sha256"


def test_demucs_runtime_has_no_legacy_loader_or_fbaipublic_fallback():
    from app.engines import demucs_cache, demucs_worker

    source = Path(demucs_cache.__file__).read_text() + Path(demucs_worker.__file__).read_text()

    assert "demucs.pretrained" not in source
    assert "fbaipublic" not in source
    assert "weights_only=False" not in source


def test_whisper_model_cache_verifier_uses_configured_model_spec(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines.lyrics import (
        WHISPER_MODEL_CACHE_SPECS,
        WhisperModelCacheSpec,
        invalid_whisper_model_cache_files,
    )

    payload = b"whisper-fixture"
    monkeypatch.setitem(
        WHISPER_MODEL_CACHE_SPECS,
        "fixture",
        WhisperModelCacheSpec(
            file_name="fixture.pt",
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        ),
    )
    (tmp_path / "fixture.pt").write_bytes(payload)

    invalid_files = invalid_whisper_model_cache_files("fixture", cache_dir=tmp_path)

    assert invalid_files == ()


def test_beat_this_model_cache_verifier_uses_torch_checkpoint_spec(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines.beat_this import (
        BEAT_THIS_CHECKPOINT_SPECS,
        BeatThisCheckpointSpec,
        invalid_beat_this_checkpoint_cache_files,
    )

    payload = b"beat-this-fixture"
    checkpoint_dir = tmp_path / "checkpoints"
    checkpoint_dir.mkdir()
    monkeypatch.setitem(
        BEAT_THIS_CHECKPOINT_SPECS,
        "fixture",
        BeatThisCheckpointSpec(
            file_name="beat_this-fixture.ckpt",
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        ),
    )
    (checkpoint_dir / "beat_this-fixture.ckpt").write_bytes(payload)

    invalid_files = invalid_beat_this_checkpoint_cache_files("fixture", checkpoint_dir=checkpoint_dir)

    assert invalid_files == ()


def test_whisper_default_cache_uses_upstream_location(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from app.config import get_settings

    monkeypatch.delenv("TUNEFORGE_LYRICS_CACHE_DIR", raising=False)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    get_settings.cache_clear()

    try:
        assert get_settings().lyrics_cache_dir == tmp_path / "xdg-cache" / "whisper"
    finally:
        get_settings.cache_clear()


def test_whisper_cache_override_expands_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from app.config import get_settings

    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("TUNEFORGE_LYRICS_CACHE_DIR", "~/lyrics-cache")
    get_settings.cache_clear()

    try:
        assert get_settings().lyrics_cache_dir == home / "lyrics-cache"
    finally:
        get_settings.cache_clear()


def test_model_bundle_seeds_missing_caches(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    torch_source = bundle_dir / "torch" / "hub" / "checkpoints" / "model.ckpt"
    whisper_source = bundle_dir / "whisper" / "lyrics.pt"
    torch_source.parent.mkdir(parents=True)
    whisper_source.parent.mkdir(parents=True)
    torch_source.write_bytes(b"torch-model")
    whisper_source.write_bytes(b"whisper-model")
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )
    torch_home = tmp_path / "torch-home"
    lyrics_cache = tmp_path / "lyrics"
    monkeypatch.setenv("TORCH_HOME", str(torch_home))

    seed_model_bundle_caches(
        SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=lyrics_cache)
    )

    assert (torch_home / "hub" / "checkpoints" / "model.ckpt").read_bytes() == b"torch-model"
    assert (lyrics_cache / "lyrics.pt").read_bytes() == b"whisper-model"


def test_model_bundle_seeds_exact_crema_onnx_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines import crema_onnx
    from app.utils import model_bundle
    from app.utils.model_cache import ExpectedModelFile

    bundle_dir = tmp_path / "bundle"
    relative_root = Path("crema") / "0.2.0" / crema_onnx.MODEL_REVISION
    payloads = {
        crema_onnx.MODEL_FILENAME: b"onnx-model",
        crema_onnx.STATE_FILENAME: b"runtime-state",
    }
    for name, payload in payloads.items():
        source = bundle_dir / relative_root / name
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(payload)
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
        crema_onnx_payloads=payloads,
    )
    (bundle_dir / "torch" / "hub" / "checkpoints").mkdir(parents=True)
    (bundle_dir / "torch" / "hub" / "checkpoints" / "model.ckpt").write_bytes(b"torch-model")
    (bundle_dir / "whisper").mkdir()
    (bundle_dir / "whisper" / "lyrics.pt").write_bytes(b"whisper-model")
    cache_root = tmp_path / "cache"

    def expected_files(root: Path) -> tuple[ExpectedModelFile, ...]:
        return tuple(
            ExpectedModelFile(
                label=f"fixture {name}",
                path=root / name,
                size=len(payload),
                sha256=hashlib.sha256(payload).hexdigest(),
            )
            for name, payload in payloads.items()
        )

    monkeypatch.setattr(model_bundle, "expected_crema_onnx_files", expected_files)
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "torch-home"))

    model_bundle.seed_model_bundle_caches(
        SimpleNamespace(
            model_bundle_dir=bundle_dir,
            lyrics_cache_dir=tmp_path / "lyrics",
            cache_root=cache_root,
        )
    )

    destination = cache_root / "models" / "crema" / "0.2.0" / crema_onnx.MODEL_REVISION
    assert {path.name: path.read_bytes() for path in destination.iterdir()} == payloads


def test_prepare_model_bundle_includes_crema_onnx_only_when_requested(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.cli import prepare_model_bundle as bundle_cli

    monkeypatch.setattr(bundle_cli, "_prepare_demucs_entries", lambda _output: [])
    monkeypatch.setattr(bundle_cli, "_prepare_whisper_entries", lambda _output, _models: [])
    monkeypatch.setattr(
        bundle_cli,
        "_prepare_crema_onnx_entries",
        lambda _output: [{"file_name": "crema.onnx"}],
    )

    without_onnx = tmp_path / "without-onnx"
    bundle_cli.prepare_model_bundle(output_dir=without_onnx, lyrics_models=[])
    with_onnx = tmp_path / "with-onnx"
    bundle_cli.prepare_model_bundle(
        output_dir=with_onnx,
        include_crema_onnx=True,
        lyrics_models=[],
    )

    assert json.loads((without_onnx / "manifest.json").read_text())["crema_onnx_files"] == []
    assert json.loads((with_onnx / "manifest.json").read_text())["crema_onnx_files"] == [
        {"file_name": "crema.onnx"}
    ]


def test_model_bundle_skips_valid_cache(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils import model_bundle

    bundle_dir = tmp_path / "bundle"
    torch_source = bundle_dir / "torch" / "hub" / "checkpoints" / "model.ckpt"
    whisper_source = bundle_dir / "whisper" / "lyrics.pt"
    torch_source.parent.mkdir(parents=True)
    whisper_source.parent.mkdir(parents=True)
    torch_source.write_bytes(b"torch-model")
    whisper_source.write_bytes(b"whisper-model")
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )
    torch_home = tmp_path / "torch-home"
    lyrics_cache = tmp_path / "lyrics"
    destination = torch_home / "hub" / "checkpoints" / "model.ckpt"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"torch-model")
    monkeypatch.setenv("TORCH_HOME", str(torch_home))

    calls: list[Path] = []

    def fake_copy2(source: Path, destination_path: Path) -> None:
        calls.append(Path(source))
        destination_path.write_bytes(Path(source).read_bytes())

    monkeypatch.setattr(model_bundle.shutil, "copy2", fake_copy2)

    model_bundle.seed_model_bundle_caches(
        SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=lyrics_cache)
    )

    assert calls == [whisper_source]
    assert destination.read_bytes() == b"torch-model"


def test_model_bundle_replaces_invalid_cache(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    torch_source = bundle_dir / "torch" / "hub" / "checkpoints" / "model.ckpt"
    whisper_source = bundle_dir / "whisper" / "lyrics.pt"
    torch_source.parent.mkdir(parents=True)
    whisper_source.parent.mkdir(parents=True)
    torch_source.write_bytes(b"torch-model")
    whisper_source.write_bytes(b"whisper-model")
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )
    torch_home = tmp_path / "torch-home"
    torch_destination = torch_home / "hub" / "checkpoints" / "model.ckpt"
    torch_destination.parent.mkdir(parents=True)
    torch_destination.write_bytes(b"stale")
    lyrics_cache = tmp_path / "lyrics"
    monkeypatch.setenv("TORCH_HOME", str(torch_home))

    seed_model_bundle_caches(
        SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=lyrics_cache)
    )

    assert torch_destination.read_bytes() == b"torch-model"


def test_model_bundle_rejects_missing_bundled_file(tmp_path: Path):
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    _write_model_bundle_manifest(
        bundle_dir,
        torch_payload=b"torch-model",
        whisper_payload=b"whisper-model",
    )

    with pytest.raises(RuntimeError, match="Bundled model file is invalid"):
        seed_model_bundle_caches(
            SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=tmp_path / "lyrics")
        )


def test_model_bundle_v1_rejects_legacy_demucs_th(tmp_path: Path):
    from app.engines.demucs_cache import LEGACY_DEMUCS_MIGRATION
    from app.utils.model_bundle import seed_model_bundle_caches

    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "torch_checkpoints": [
                    {
                        "label": "Demucs htdemucs_6s legacy checkpoint",
                        "file_name": "legacy.th",
                        "relative_path": "torch/hub/checkpoints/legacy.th",
                        "size": 1,
                        "sha256": "0" * 64,
                    }
                ],
                "whisper_models": [],
                "crema_onnx_files": [],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError) as exc_info:
        seed_model_bundle_caches(
            SimpleNamespace(model_bundle_dir=bundle_dir, lyrics_cache_dir=tmp_path / "lyrics")
        )
    assert str(exc_info.value) == LEGACY_DEMUCS_MIGRATION


@pytest.mark.parametrize(
    "missing_field",
    ["torch_checkpoints", "demucs_hf_models", "whisper_models", "crema_onnx_files"],
)
def test_model_bundle_v2_requires_all_list_fields(tmp_path: Path, missing_field: str):
    from app.utils.model_bundle import demucs_model_bundle_repo

    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    manifest = {
        "version": 2,
        "torch_checkpoints": [],
        "demucs_hf_models": [],
        "whisper_models": [],
        "crema_onnx_files": [],
    }
    del manifest[missing_field]
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(RuntimeError, match=f"missing required field: {missing_field}"):
        demucs_model_bundle_repo(bundle_dir)


@pytest.mark.parametrize("version", [True, 1.0, "2", None, {"value": 2}])
def test_model_bundle_rejects_non_integer_or_boolean_versions(tmp_path: Path, version: object):
    from app.utils.model_bundle import demucs_model_bundle_repo

    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "manifest.json").write_text(
        json.dumps({"version": version}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="version must be an integer"):
        demucs_model_bundle_repo(bundle_dir)


@pytest.mark.parametrize("manifest", [[], True, "v2", 2, None])
def test_model_bundle_rejects_non_object_manifests(tmp_path: Path, manifest: object):
    from app.utils.model_bundle import demucs_model_bundle_repo

    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(RuntimeError, match="manifest must be an object"):
        demucs_model_bundle_repo(bundle_dir)


def test_model_bundle_v2_nonempty_demucs_set_must_be_complete(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.utils import model_bundle

    models = tuple(
        SimpleNamespace(
            id=model_id,
            mode="fixture",
            repo_id=f"fixture/{model_id}",
            revision=revision * 40,
            yaml_file=f"{model_id}.yaml",
            bag_order=(),
            files=(),
        )
        for model_id, revision in (("model-a", "a"), ("model-b", "b"))
    )
    monkeypatch.setattr(model_bundle, "read_demucs_hf_models", lambda: models)
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    (bundle_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 2,
                "torch_checkpoints": [],
                "demucs_hf_models": [
                    {
                        "id": "model-a",
                        "mode": "fixture",
                        "repo_id": "fixture/model-a",
                        "revision": "a" * 40,
                        "yaml_file": "model-a.yaml",
                        "bag_order": [],
                        "files": [],
                    }
                ],
                "whisper_models": [],
                "crema_onnx_files": [],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="missing supported Demucs model.*model-b"):
        model_bundle.demucs_model_bundle_repo(bundle_dir)


def test_model_bundle_v2_validates_demucs_in_place_without_copying(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from app.engines.demucs_cache import read_demucs_hf_models
    from app.utils import model_bundle

    canonical = read_demucs_hf_models(model_ids=("htdemucs_6s",))[0]
    bundle_dir = tmp_path / "bundle"
    files = []
    for file in canonical.files:
        relative_path = Path("demucs") / canonical.id / canonical.revision / file.file_name
        destination = bundle_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = b"x"
        # Keep this test disposable and small by substituting fixture metadata below.
        destination.write_bytes(payload)
        files.append(
            {
                "label": file.label,
                "file_name": file.file_name,
                "relative_path": relative_path.as_posix(),
                "size": 1,
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    fixture_model = SimpleNamespace(
        id=canonical.id,
        mode=canonical.mode,
        repo_id=canonical.repo_id,
        revision=canonical.revision,
        yaml_file=canonical.yaml_file,
        bag_order=canonical.bag_order,
        files=tuple(
            SimpleNamespace(
                label=entry["label"],
                file_name=entry["file_name"],
                size=entry["size"],
                sha256=entry["sha256"],
            )
            for entry in files
        ),
    )
    monkeypatch.setattr(model_bundle, "read_demucs_hf_models", lambda: (fixture_model,))
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "torch-home"))
    copied: list[Path] = []
    monkeypatch.setattr(model_bundle.shutil, "copy2", lambda source, _dest: copied.append(Path(source)))
    (bundle_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 2,
                "torch_checkpoints": [],
                "demucs_hf_models": [
                    {
                        "id": fixture_model.id,
                        "mode": fixture_model.mode,
                        "repo_id": fixture_model.repo_id,
                        "revision": fixture_model.revision,
                        "yaml_file": fixture_model.yaml_file,
                        "bag_order": list(fixture_model.bag_order),
                        "files": files,
                    }
                ],
                "whisper_models": [],
                "crema_onnx_files": [],
            }
        ),
        encoding="utf-8",
    )

    assert model_bundle.demucs_model_bundle_repo(bundle_dir) == bundle_dir / "demucs"
    model_bundle.seed_model_bundle_caches(
        SimpleNamespace(
            model_bundle_dir=bundle_dir,
            lyrics_cache_dir=tmp_path / "lyrics",
            cache_root=tmp_path / "cache",
        )
    )

    assert copied == []
    assert not (tmp_path / "cache" / "models" / "huggingface").exists()


def test_model_cache_verifier_imports_no_ml_runtimes():
    script = (
        "import json, sys; "
        "import app.cli.prewarm_models; "
        "print(json.dumps({name: name in sys.modules "
        "for name in ['torch', 'whisper', 'beat_this', 'demucs', 'crema', 'tensorflow', 'keras']}))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )

    imported = json.loads(completed.stdout)
    assert imported == {
        "torch": False,
        "whisper": False,
        "beat_this": False,
        "demucs": False,
        "crema": False,
        "tensorflow": False,
        "keras": False,
    }


def _write_hf_demucs_manifest(tmp_path: Path) -> tuple[Path, dict[str, bytes]]:
    payloads = {
        "model-a.yaml": b"models: ['sig-a']\n",
        "sig-a.safetensors": b"safe-model",
    }
    manifest_path = tmp_path / "models.json"
    manifest_path.write_text(
        json.dumps(
            {
                "version": 2,
                "models": [
                    {
                        "id": "model-a",
                        "mode": "fixture",
                        "repo_id": "fixture/model-a",
                        "revision": "a" * 40,
                        "yaml_file": "model-a.yaml",
                        "bag_order": ["sig-a"],
                        "files": [
                            {
                                "label": "bag definition",
                                "file_name": name,
                                "size": len(payload),
                                "sha256": hashlib.sha256(payload).hexdigest(),
                            }
                            for name, payload in payloads.items()
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return manifest_path, payloads


def _write_model_bundle_manifest(
    bundle_dir: Path,
    *,
    torch_payload: bytes,
    whisper_payload: bytes,
    crema_onnx_payloads: dict[str, bytes] | None = None,
) -> None:
    crema_onnx_payloads = crema_onnx_payloads or {}
    (bundle_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "torch_checkpoints": [
                    {
                        "label": "fixture torch",
                        "file_name": "model.ckpt",
                        "relative_path": "torch/hub/checkpoints/model.ckpt",
                        "size": len(torch_payload),
                        "sha256": hashlib.sha256(torch_payload).hexdigest(),
                    }
                ],
                "whisper_models": [
                    {
                        "label": "fixture whisper",
                        "file_name": "lyrics.pt",
                        "relative_path": "whisper/lyrics.pt",
                        "size": len(whisper_payload),
                        "sha256": hashlib.sha256(whisper_payload).hexdigest(),
                    }
                ],
                "crema_onnx_files": [
                    {
                        "label": f"fixture {name}",
                        "file_name": name,
                        "relative_path": (
                            f"crema/0.2.0/65af18f49af5101267fd28f15ac8c452d98b8e3d/{name}"
                        ),
                        "size": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                    for name, payload in crema_onnx_payloads.items()
                ],
            }
        ),
        encoding="utf-8",
    )
