from pathlib import Path

import pytest

from app.engines import audio_encoding
from app.errors import AppError
from app.services.audio_working import materialize_pcm_wav


@pytest.mark.parametrize(
    ("output_format", "profile"),
    [
        ("wav", ("-c:a", "pcm_s16le")),
        ("flac", ("-c:a", "flac", "-compression_level", "5")),
        ("mp3", ("-c:a", "libmp3lame", "-b:a", "192k")),
        ("m4a", ("-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k", "-f", "mp4")),
    ],
)
def test_durable_encoding_profiles_match_export_contract(
    output_format: str,
    profile: tuple[str, ...],
) -> None:
    assert audio_encoding.encoding_profile(output_format) == profile


@pytest.mark.parametrize("profile", ["HE-AAC", "HE-AACv2", None])
def test_m4a_validation_rejects_non_lc_aac(monkeypatch, profile: str | None) -> None:
    monkeypatch.setattr(
        audio_encoding,
        "probe_audio_file",
        lambda _path: {
            "streams": [
                {"codec_name": "aac", "profile": profile, "channels": 2, "sample_rate": 48000}
            ],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
        },
    )

    with pytest.raises(AppError, match="not valid M4A"):
        audio_encoding.validate_audio_file(Path("fixture.m4a"), "m4a")


def test_m4a_validation_accepts_aac_lc(monkeypatch) -> None:
    monkeypatch.setattr(
        audio_encoding,
        "probe_audio_file",
        lambda _path: {
            "streams": [
                {"codec_name": "aac", "profile": "LC", "channels": 2, "sample_rate": 48000}
            ],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
        },
    )

    audio_encoding.validate_audio_file(Path("fixture.m4a"), "m4a")


def test_materialize_pcm_wav_cleans_compressed_working_file(sample_mp3_file: Path) -> None:
    with materialize_pcm_wav(sample_mp3_file) as working_path:
        working_root = working_path.parent
        assert working_path.exists()
        assert working_path.suffix == ".wav"
        audio_encoding.validate_audio_file(working_path, "wav")

    assert not working_root.exists()


def test_materialize_pcm_wav_reuses_durable_pcm_wav(sample_audio_file: Path) -> None:
    with materialize_pcm_wav(sample_audio_file) as working_path:
        assert working_path == sample_audio_file

    assert sample_audio_file.exists()
