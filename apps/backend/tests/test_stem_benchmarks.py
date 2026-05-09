from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import soundfile as sf
import torch

from app.benchmarks.stems import build_benchmark_report
from app.benchmarks.stems import main as benchmark_main


class FakeStemModel:
    def __init__(self, name: str, sources: list[str]) -> None:
        self.name = name
        self.sources = sources
        self.samplerate = 44100
        self.audio_channels = 2


def test_stem_benchmark_command_emits_json_and_writes_expected_outputs(
    sample_stereo_audio_file: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    _stub_demucs_runtime(monkeypatch)
    output_dir = tmp_path / "bench"

    exit_code = benchmark_main(
        [
            "--audio",
            str(sample_stereo_audio_file),
            "--model",
            "htdemucs_ft",
            "--model",
            "htdemucs_6s",
            "--device",
            "auto",
            "--output-dir",
            str(output_dir),
            "--json-only",
        ]
    )

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    results = payload["tracks"][0]["results"]
    two_stem_result = results[0]
    six_stem_result = results[1]

    assert exit_code == 0
    assert payload["output_dir"] == str(output_dir.resolve())
    assert two_stem_result["model"] == "htdemucs_ft"
    assert two_stem_result["available"] is True
    assert two_stem_result["sources"] == ["vocals", "instrumental"]
    assert six_stem_result["model"] == "htdemucs_6s"
    assert six_stem_result["available"] is True
    assert six_stem_result["sources"] == ["drums", "bass", "other", "vocals", "guitar", "piano"]
    assert six_stem_result["device"] == "cpu"
    assert six_stem_result["runtime_ratio"] is not None
    assert all(Path(output["path"]).is_relative_to(output_dir) for output in two_stem_result["output_files"])
    assert all(Path(output["path"]).is_relative_to(output_dir) for output in six_stem_result["output_files"])
    assert not list(sample_stereo_audio_file.parent.glob("*.stem.wav"))


def test_stem_benchmark_aggregates_non_vocal_sources_for_baseline(
    sample_stereo_audio_file: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _stub_demucs_runtime(monkeypatch)

    report = build_benchmark_report(
        [sample_stereo_audio_file],
        model_names=["htdemucs_ft"],
        device="cpu",
        output_dir=tmp_path / "bench",
    )

    result = report["tracks"][0]["results"][0]
    vocal_path = Path(result["output_files"][0]["path"])
    instrumental_path = Path(result["output_files"][1]["path"])
    vocals, _ = sf.read(vocal_path, always_2d=True)
    instrumental, _ = sf.read(instrumental_path, always_2d=True)

    assert result["sources"] == ["vocals", "instrumental"]
    assert vocals[0, 0] == pytest.approx(0.04, abs=1e-4)
    assert instrumental[0, 0] == pytest.approx(0.06, abs=1e-4)


def test_stem_benchmark_reads_webm_duration_with_ffprobe(
    sample_webm_file: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _stub_demucs_runtime(monkeypatch)

    report = build_benchmark_report(
        [sample_webm_file],
        model_names=["htdemucs_6s"],
        device="cpu",
        output_dir=tmp_path / "bench",
    )

    track = report["tracks"][0]
    result = track["results"][0]
    assert track["track_duration_seconds"] == pytest.approx(2.0, abs=0.05)
    assert result["track_duration_seconds"] == pytest.approx(2.0, abs=0.05)
    assert result["runtime_ratio"] is not None


def test_stem_benchmark_reports_model_and_separation_failures(
    sample_stereo_audio_file: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    def fake_get_model(model_name: str) -> FakeStemModel:
        if model_name == "missing_model":
            raise RuntimeError("model unavailable")
        return FakeStemModel(model_name, ["drums", "bass", "other", "vocals", "guitar", "piano"])

    def fake_apply_model(*args: Any, **kwargs: Any) -> torch.Tensor:
        raise RuntimeError("separation failed")

    monkeypatch.setattr("app.benchmarks.stems.choose_torch_device", lambda *args, **kwargs: "cpu")
    monkeypatch.setattr("app.benchmarks.stems.get_model", fake_get_model)
    monkeypatch.setattr("app.benchmarks.stems.apply_model", fake_apply_model)

    report = build_benchmark_report(
        [sample_stereo_audio_file],
        model_names=["missing_model", "htdemucs_6s"],
        device="cpu",
        output_dir=tmp_path / "bench",
    )

    missing_result = report["tracks"][0]["results"][0]
    failed_result = report["tracks"][0]["results"][1]
    assert missing_result["available"] is False
    assert missing_result["error"] == "model unavailable"
    assert failed_result["available"] is False
    assert failed_result["error"] == "separation failed"
    assert failed_result["output_files"] == []


def _stub_demucs_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get_model(model_name: str) -> FakeStemModel:
        if model_name == "htdemucs_6s":
            return FakeStemModel(model_name, ["drums", "bass", "other", "vocals", "guitar", "piano"])
        return FakeStemModel(model_name, ["drums", "bass", "other", "vocals"])

    def fake_apply_model(model: FakeStemModel, mix: torch.Tensor, *args: Any, **kwargs: Any) -> torch.Tensor:
        values = [0.01 * (index + 1) for index in range(len(model.sources))]
        output = torch.zeros((1, len(model.sources), model.audio_channels, mix.shape[-1]), dtype=torch.float32)
        for index, value in enumerate(values):
            output[:, index, :, :] = value
        return output

    monkeypatch.setattr("app.benchmarks.stems.choose_torch_device", lambda *args, **kwargs: "cpu")
    monkeypatch.setattr("app.benchmarks.stems.get_model", fake_get_model)
    monkeypatch.setattr("app.benchmarks.stems.apply_model", fake_apply_model)
