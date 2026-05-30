from __future__ import annotations

import argparse
import html
import importlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.request import pathname2url

BACKEND_ROOT = Path(__file__).resolve().parents[1] / "apps" / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

audio_signal = importlib.import_module("app.engines.audio_signal")

PEAK_THRESHOLD = 0.001
RMS_THRESHOLD = 0.00005
ACTIVE_DURATION_THRESHOLD_SECONDS = 0.20
ANALYSIS_WINDOW_SECONDS = 0.05
DEFAULT_WIDTH = 1600
PROJECT_ID_PREFIX = "proj_sha256_"
PROJECT_STORAGE_KEY_PREFIX = "proj_"
PROJECT_STORAGE_HASH_LENGTH = 24
HEX_DIGITS = frozenset("0123456789abcdef")
STEM_ORDER = ("drums", "bass", "other", "guitar", "piano", "vocals")
EXPECTED_STEM_SOURCES = (*STEM_ORDER, "instrumental")
STEM_ARTIFACT_TYPE_TO_SOURCE = {
    "vocal_stem": "vocals",
    "instrumental_stem": "instrumental",
    **{f"{stem_name}_stem": stem_name for stem_name in STEM_ORDER if stem_name != "vocals"},
}
SAFE_FILENAME_PATTERN = re.compile(r"[^a-z0-9._-]+")


@dataclass(frozen=True)
class Thresholds:
    peak: float
    rms: float
    active_duration: float
    window_seconds: float


@dataclass(frozen=True)
class ProjectInfo:
    project_id: str
    storage_key: str
    display_name: str
    duration_seconds: float | None


@dataclass(frozen=True)
class StemPath:
    storage_key: str
    artifact_id: str
    source_artifact_id: str
    model: str
    stemset: str
    stem_name: str
    path: Path


@dataclass(frozen=True)
class StemMetrics:
    has_signal: bool
    peak: float
    rms: float
    active_duration_seconds: float
    inspected_duration_seconds: float
    sample_rate: int
    channels: int
    bins: list[float]


@dataclass(frozen=True)
class StemArtifactRow:
    artifact_id: str
    project_id: str
    artifact_type: str
    artifact_format: str
    path: str
    metadata: dict[str, object]


@dataclass
class StemsetRender:
    source_artifact_id: str
    model: str
    stemset: str
    stems: dict[str, StemMetrics] = field(default_factory=dict)


def main() -> int:
    start_time = time.perf_counter()
    parser = build_parser()
    args = parser.parse_args()

    try:
        thresholds = Thresholds(
            peak=positive_float(args.peak_threshold, "--peak-threshold"),
            rms=positive_float(args.rms_threshold, "--rms-threshold"),
            active_duration=positive_float(
                args.active_duration_threshold,
                "--active-duration-threshold",
                allow_zero=True,
            ),
            window_seconds=positive_float(args.window_seconds, "--window-seconds"),
        )
        width = positive_int(args.width, "--width")
        data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else default_data_dir()
        output_dir = Path(args.output_dir).expanduser().resolve()
        if is_relative_to(output_dir, data_dir):
            raise DiagnosticError(
                f"Output dir must be outside the TuneForge data dir: {output_dir}"
            )

        if not data_dir.is_dir():
            raise DiagnosticError(f"Data dir not found: {data_dir}")
        database_path = data_dir / "app.sqlite"
        if not database_path.is_file():
            raise DiagnosticError(f"Database not found: {database_path}")

        project_info = load_project_info(database_path)
        stem_paths = load_stem_paths(database_path, data_dir)
        if not stem_paths:
            raise DiagnosticError(f"No DB-registered stem WAV artifacts found in: {database_path}")

        selected_keys = selected_storage_keys(args.project_id, project_info)
        if selected_keys is not None:
            stem_paths = [stem for stem in stem_paths if stem.storage_key in selected_keys]
            if not stem_paths:
                raise DiagnosticError("No stem WAV files matched selected project ids/storage keys.")

        projects = group_projects(stem_paths)
        output_dir.mkdir(parents=True, exist_ok=True)

        projects_written = 0
        stems_scanned = 0
        for storage_key, stemsets in sorted(projects.items()):
            rendered_stemsets: list[StemsetRender] = []
            for stemset_key, stems in sorted(stemsets.items()):
                source_artifact_id, model, stemset = stemset_key
                rendered = StemsetRender(
                    source_artifact_id=source_artifact_id,
                    model=model,
                    stemset=stemset,
                )
                for stem in sorted_stems(stems):
                    rendered.stems[stem.stem_name] = analyze_stem(
                        stem.path,
                        width=width,
                        thresholds=thresholds,
                    )
                    stems_scanned += 1
                rendered_stemsets.append(rendered)

            info = project_info.get(storage_key)
            project_label = info.display_name if info is not None else storage_key
            svg = render_project_svg(
                storage_key=storage_key,
                project_info=info,
                project_label=project_label,
                stemsets=rendered_stemsets,
                thresholds=thresholds,
                width=width,
            )
            output_path = output_dir / f"{safe_slug(project_label)}-{storage_key}.svg"
            output_path.write_text(svg, encoding="utf-8")
            projects_written += 1

        summary = {
            "data_dir": str(data_dir),
            "output_dir": str(output_dir),
            "projects_written": projects_written,
            "stems_scanned": stems_scanned,
            "elapsed_seconds": round(time.perf_counter() - start_time, 3),
            "thresholds": {
                "peak": thresholds.peak,
                "rms": thresholds.rms,
                "active_duration_seconds": thresholds.active_duration,
                "window_seconds": thresholds.window_seconds,
            },
        }
        print(json.dumps(summary, sort_keys=True))
        return 0
    except DiagnosticError as error:
        print(f"stem-waveforms: {error}", file=sys.stderr)
        return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render read-only SVG waveform diagnostics for existing TuneForge stems.",
    )
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=Path("stem-waveforms"))
    parser.add_argument("--project-id", action="append", default=[])
    parser.add_argument("--peak-threshold", type=float, default=PEAK_THRESHOLD)
    parser.add_argument("--rms-threshold", type=float, default=RMS_THRESHOLD)
    parser.add_argument(
        "--active-duration-threshold",
        type=float,
        default=ACTIVE_DURATION_THRESHOLD_SECONDS,
    )
    parser.add_argument("--window-seconds", type=float, default=ANALYSIS_WINDOW_SECONDS)
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    return parser


class DiagnosticError(Exception):
    pass


def positive_float(value: float, name: str, *, allow_zero: bool = False) -> float:
    if not math.isfinite(value) or value < 0.0 or (value == 0.0 and not allow_zero):
        qualifier = "non-negative" if allow_zero else "positive"
        raise DiagnosticError(f"{name} must be finite and {qualifier}.")
    return value


def positive_int(value: int, name: str) -> int:
    if value <= 0:
        raise DiagnosticError(f"{name} must be positive.")
    return value


def default_data_dir() -> Path:
    override = os.environ.get("TUNEFORGE_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Tuneforge"
    return home / ".local" / "share" / "tuneforge"


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def load_project_info(database_path: Path) -> dict[str, ProjectInfo]:
    uri = f"file:{pathname2url(str(database_path))}?mode=ro"
    try:
        with sqlite3.connect(uri, uri=True) as connection:
            rows = connection.execute(
                "SELECT id, display_name, duration_seconds FROM projects ORDER BY id"
            ).fetchall()
    except sqlite3.Error as error:
        raise DiagnosticError(f"Could not read database in read-only mode: {error}") from error

    projects: dict[str, ProjectInfo] = {}
    for project_id, display_name, duration_seconds in rows:
        storage_key = project_id_to_storage_key(str(project_id))
        projects[storage_key] = ProjectInfo(
            project_id=str(project_id),
            storage_key=storage_key,
            display_name=str(display_name),
            duration_seconds=float(duration_seconds) if duration_seconds is not None else None,
        )
    return projects


def load_stem_paths(database_path: Path, data_dir: Path) -> list[StemPath]:
    projects_dir = data_dir / "projects"
    if not projects_dir.is_dir():
        raise DiagnosticError(f"Projects dir not found: {projects_dir}")

    stems: list[StemPath] = []
    for artifact in load_stem_artifact_rows(database_path):
        parsed = parse_artifact_stem_path(data_dir, artifact)
        if parsed is not None:
            stems.append(parsed)
    return stems


def load_stem_artifact_rows(database_path: Path) -> list[StemArtifactRow]:
    uri = f"file:{pathname2url(str(database_path))}?mode=ro"
    try:
        with sqlite3.connect(uri, uri=True) as connection:
            rows = connection.execute(
                """
                SELECT id, project_id, type, format, path, metadata_json
                FROM artifacts
                WHERE lower(format) = 'wav'
                ORDER BY project_id, type, id
                """
            ).fetchall()
    except sqlite3.Error as error:
        raise DiagnosticError(f"Could not read artifacts in read-only mode: {error}") from error

    artifacts: list[StemArtifactRow] = []
    for artifact_id, project_id, artifact_type, artifact_format, path, metadata_json in rows:
        normalized_type = str(artifact_type)
        normalized_format = str(artifact_format).lower()
        if not is_stem_artifact_type(normalized_type) or normalized_format != "wav":
            continue
        artifacts.append(
            StemArtifactRow(
                artifact_id=str(artifact_id),
                project_id=str(project_id),
                artifact_type=normalized_type,
                artifact_format=normalized_format,
                path=str(path),
                metadata=parse_artifact_metadata(metadata_json),
            )
        )
    return artifacts


def parse_artifact_metadata(raw_metadata: object) -> dict[str, object]:
    if raw_metadata is None:
        return {}
    if isinstance(raw_metadata, bytes):
        raw_metadata = raw_metadata.decode("utf-8", errors="replace")
    if not isinstance(raw_metadata, str):
        return {}
    try:
        parsed: object = json.loads(raw_metadata)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(key): value for key, value in parsed.items()}


def is_stem_artifact_type(artifact_type: str) -> bool:
    return (
        artifact_type.endswith("_stem")
        or artifact_type in STEM_ARTIFACT_TYPE_TO_SOURCE
        or artifact_type in EXPECTED_STEM_SOURCES
    )


def metadata_string(metadata: dict[str, object], key: str) -> str | None:
    value = metadata.get(key)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def source_from_artifact_type(artifact_type: str) -> str | None:
    if artifact_type in STEM_ARTIFACT_TYPE_TO_SOURCE:
        return STEM_ARTIFACT_TYPE_TO_SOURCE[artifact_type]
    if artifact_type in EXPECTED_STEM_SOURCES:
        return artifact_type
    if artifact_type.endswith("_stem"):
        source = artifact_type.removesuffix("_stem")
        if source == "vocal":
            return "vocals"
        return source
    return None


def project_id_to_storage_key(project_id: str) -> str:
    if not project_id.startswith(PROJECT_ID_PREFIX):
        return project_id
    source_sha256 = project_id.removeprefix(PROJECT_ID_PREFIX).strip().lower()
    if len(source_sha256) != 64 or any(character not in HEX_DIGITS for character in source_sha256):
        return project_id
    return f"{PROJECT_STORAGE_KEY_PREFIX}{source_sha256[:PROJECT_STORAGE_HASH_LENGTH]}"


def selected_storage_keys(
    project_ids: list[str],
    project_info: dict[str, ProjectInfo],
) -> set[str] | None:
    if not project_ids:
        return None

    by_project_id = {info.project_id: storage_key for storage_key, info in project_info.items()}
    selected: set[str] = set()
    for raw_project_id in project_ids:
        project_id = raw_project_id.strip()
        if not project_id:
            raise DiagnosticError("--project-id cannot be empty.")
        selected.add(project_id_to_storage_key(project_id))
        if project_id in by_project_id:
            selected.add(by_project_id[project_id])
    return selected


def parse_artifact_stem_path(data_dir: Path, artifact: StemArtifactRow) -> StemPath | None:
    path = resolve_artifact_path(data_dir, artifact.path)
    if not path.is_file():
        return None

    projects_dir = data_dir / "projects"
    if not is_relative_to(path, projects_dir):
        return None

    relative = path.relative_to(projects_dir)
    parts = relative.parts
    if len(parts) < 5 or parts[1] != "stems":
        return None

    storage_key = project_id_to_storage_key(artifact.project_id)
    if parts[0] != storage_key:
        return None

    after_stems = parts[2:]
    if len(after_stems) < 3:
        return None

    source_artifact_id = metadata_string(artifact.metadata, "source_artifact_id") or after_stems[0]
    model = metadata_string(artifact.metadata, "stem_model") or after_stems[1]
    stemset = "/".join(after_stems[2:-1]) or "default"
    stem_name = (
        metadata_string(artifact.metadata, "stem_source")
        or source_from_artifact_type(artifact.artifact_type)
        or path.stem
    )
    return StemPath(
        storage_key=storage_key,
        artifact_id=artifact.artifact_id,
        source_artifact_id=source_artifact_id,
        model=model,
        stemset=stemset,
        stem_name=stem_name,
        path=path,
    )


def resolve_artifact_path(data_dir: Path, raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = data_dir / path
    return path.resolve()


def group_projects(
    stems: list[StemPath],
) -> dict[str, dict[tuple[str, str, str], list[StemPath]]]:
    grouped: dict[str, dict[tuple[str, str, str], list[StemPath]]] = {}
    for stem in stems:
        project = grouped.setdefault(stem.storage_key, {})
        stemset_key = (stem.source_artifact_id, stem.model, stem.stemset)
        project.setdefault(stemset_key, []).append(stem)
    return grouped


def sorted_stems(stems: list[StemPath]) -> list[StemPath]:
    order = {stem_name: index for index, stem_name in enumerate(STEM_ORDER)}
    return sorted(stems, key=lambda stem: (order.get(stem.stem_name, len(order)), stem.stem_name))


def analyze_stem(path: Path, *, width: int, thresholds: Thresholds) -> StemMetrics:
    shared_thresholds = audio_signal.AudioSignalThresholds(
        peak=thresholds.peak,
        rms=thresholds.rms,
        active_duration_seconds=thresholds.active_duration,
        window_seconds=thresholds.window_seconds,
    )
    try:
        summary = audio_signal.inspect_audio_signal_file(
            path,
            shared_thresholds,
            bin_count=width,
        )
    except (OSError, RuntimeError) as error:
        raise DiagnosticError(f"Could not read stem audio {path}: {error}") from error

    bins = summary.bins if summary.bins is not None else ()
    return StemMetrics(
        has_signal=summary.has_signal,
        peak=summary.peak,
        rms=summary.rms,
        active_duration_seconds=summary.active_duration_seconds,
        inspected_duration_seconds=summary.inspected_duration_seconds,
        sample_rate=summary.sample_rate,
        channels=summary.channels,
        bins=list(bins),
    )


def render_project_svg(
    *,
    storage_key: str,
    project_info: ProjectInfo | None,
    project_label: str,
    stemsets: list[StemsetRender],
    thresholds: Thresholds,
    width: int,
) -> str:
    label_width = 330
    plot_width = width
    row_height = 64
    row_gap = 12
    stemset_header_height = 58
    top_height = 120
    bottom_margin = 36
    svg_width = label_width + plot_width + 48
    svg_height = top_height + bottom_margin + sum(
        stemset_header_height + len(stemset.stems) * (row_height + row_gap)
        for stemset in stemsets
    )

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{svg_width}" height="{svg_height}" '
        f'viewBox="0 0 {svg_width} {svg_height}" role="img">',
        "<style>",
        "text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#17202a}",
        ".muted{fill:#64748b}.pass{fill:#166534}.fail{fill:#991b1b}",
        ".axis{stroke:#cbd5e1;stroke-width:1}.wave{fill:#2563eb;fill-opacity:.72}",
        ".strip{fill:#f8fafc;stroke:#d7dee8;stroke-width:1}",
        "</style>",
        f"<title>{escape(project_label)} stem waveforms</title>",
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="24" y="38" font-size="24" font-weight="700">{escape(project_label)}</text>',
        f'<text x="24" y="64" font-size="13" class="muted">storage key: {escape(storage_key)}</text>',
    ]
    if project_info is not None:
        duration = (
            f"{project_info.duration_seconds:.2f}s"
            if project_info.duration_seconds is not None
            else "unknown"
        )
        lines.append(
            f'<text x="24" y="84" font-size="13" class="muted">'
            f'project id: {escape(project_info.project_id)} - duration: {duration}</text>'
        )
    lines.append(
        f'<text x="24" y="106" font-size="13" class="muted">thresholds: '
        f'peak &gt;= {thresholds.peak:g}, RMS &gt;= {thresholds.rms:g}, '
        f'active &gt;= {thresholds.active_duration:g}s, '
        f'window {thresholds.window_seconds:g}s</text>'
    )

    y = top_height
    for stemset in stemsets:
        stemset_peak = max((max(metrics.bins, default=0.0) for metrics in stemset.stems.values()), default=0.0)
        scale = stemset_peak if stemset_peak > 0 else 1.0
        lines.append(
            f'<text x="24" y="{y + 24}" font-size="16" font-weight="700">'
            f'{escape(stemset.model)} / {escape(stemset.stemset)}</text>'
        )
        lines.append(
            f'<text x="24" y="{y + 44}" font-size="12" class="muted">'
            f'source artifact: {escape(stemset.source_artifact_id)} - '
            f'shared scale peak: {scale:.6g}</text>'
        )
        y += stemset_header_height
        for stem_name, metrics in sorted_rendered_stems(stemset.stems):
            lines.extend(
                render_stem_row(
                    stem_name=stem_name,
                    metrics=metrics,
                    x=24,
                    y=y,
                    label_width=label_width,
                    plot_width=plot_width,
                    row_height=row_height,
                    scale=scale,
                )
            )
            y += row_height + row_gap

    lines.append("</svg>")
    return "\n".join(lines)


def sorted_rendered_stems(stems: dict[str, StemMetrics]) -> list[tuple[str, StemMetrics]]:
    order = {stem_name: index for index, stem_name in enumerate(STEM_ORDER)}
    return sorted(stems.items(), key=lambda item: (order.get(item[0], len(order)), item[0]))


def render_stem_row(
    *,
    stem_name: str,
    metrics: StemMetrics,
    x: int,
    y: int,
    label_width: int,
    plot_width: int,
    row_height: int,
    scale: float,
) -> list[str]:
    plot_x = x + label_width
    mid_y = y + row_height / 2
    half_height = row_height * 0.34
    status = "PASS" if metrics.has_signal else "NO SIGNAL"
    status_class = "pass" if metrics.has_signal else "fail"
    label = (
        f"peak {metrics.peak:.6g} - RMS {metrics.rms:.6g} - "
        f"active {metrics.active_duration_seconds:.3f}s - {status}"
    )
    points_top: list[str] = []
    points_bottom: list[str] = []
    for index, value in enumerate(metrics.bins):
        point_x = plot_x + (index / max(1, len(metrics.bins) - 1)) * plot_width
        amplitude = min(1.0, value / scale) * half_height
        points_top.append(f"{point_x:.2f},{mid_y - amplitude:.2f}")
        points_bottom.append(f"{point_x:.2f},{mid_y + amplitude:.2f}")
    polygon = " ".join([*points_top, *reversed(points_bottom)])
    return [
        f'<text x="{x}" y="{y + 22}" font-size="14" font-weight="700">{escape(stem_name)}</text>',
        f'<text x="{x}" y="{y + 44}" font-size="12" class="{status_class}">{escape(label)}</text>',
        f'<rect x="{plot_x}" y="{y}" width="{plot_width}" height="{row_height}" rx="4" class="strip"/>',
        f'<line x1="{plot_x}" y1="{mid_y:.2f}" x2="{plot_x + plot_width}" '
        f'y2="{mid_y:.2f}" class="axis"/>',
        f'<polygon points="{polygon}" class="wave"/>',
    ]


def safe_slug(value: str) -> str:
    slug = SAFE_FILENAME_PATTERN.sub("-", value.strip().lower()).strip("-._")
    return slug[:80] or "project"


def escape(value: str) -> str:
    return html.escape(value, quote=True)


if __name__ == "__main__":
    raise SystemExit(main())
