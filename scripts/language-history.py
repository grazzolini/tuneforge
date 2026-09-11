#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[1]
LINGUIST_IMAGE = "ghcr.io/github-linguist/linguist:latest"
DEFAULT_OUTPUT_DIR = Path("linguist-animation")
WIDTH = 900

BG = "#0d1117"
PANEL = "#161b22"
BORDER = "#30363d"
TEXT = "#e6edf3"
MUTED = "#8b949e"

COLORS = {
    "Python": "#3572A5",
    "TypeScript": "#3178c6",
    "Rust": "#dea584",
    "JavaScript": "#f1e05a",
    "CSS": "#663399",
    "Shell": "#89e051",
    "HTML": "#e34c26",
    "Mako": "#7e858d",
    "CMake": "#DA3434",
}
FALLBACK_COLORS = (
    "#a371f7",
    "#2f81f7",
    "#f78166",
    "#56d364",
    "#e3b341",
    "#d2a8ff",
    "#79c0ff",
)

FONT_REGULAR_PATHS = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)
FONT_BOLD_PATHS = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


class LanguageHistoryError(Exception):
    pass


@dataclass(frozen=True)
class LanguageStat:
    language: str
    size: int
    percentage: float


@dataclass(frozen=True)
class CommitMeta:
    index: int
    revision: str
    date: str
    subject: str


@dataclass(frozen=True)
class Snapshot:
    meta: CommitMeta
    languages: tuple[LanguageStat, ...]


@dataclass(frozen=True)
class OutputPaths:
    root: Path

    @property
    def commits(self) -> Path:
        return self.root / "commits.tsv"

    @property
    def snapshots(self) -> Path:
        return self.root / "linguist-json"

    @property
    def frames(self) -> Path:
        return self.root / "frames-png"

    @property
    def csv(self) -> Path:
        return self.root / "language-history.csv"

    @property
    def gif(self) -> Path:
        return self.root / "tuneforge-language-evolution.gif"

    @property
    def mp4(self) -> Path:
        return self.root / "tuneforge-language-evolution.mp4"


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.fps <= 0:
            raise LanguageHistoryError("--fps must be positive.")
        if args.refresh and args.render_only:
            raise LanguageHistoryError("--refresh cannot be combined with --render-only.")

        output_dir = args.output_dir.expanduser().resolve()
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=f".{output_dir.name}.",
            dir=output_dir.parent,
        ) as temporary_dir:
            paths = OutputPaths(Path(temporary_dir))
            paths.root.mkdir(parents=True, exist_ok=True)
            if args.render_only:
                copy_existing_inputs(OutputPaths(output_dir), paths)
            else:
                if args.refresh:
                    run_command(["git", "fetch", "origin", "main"], cwd=REPO_ROOT)
                revision = resolve_revision(args.ref)
                write_commit_list(revision, paths.commits)
                collect_linguist(paths)
            snapshots = load_snapshots(paths.snapshots)
            render_artifacts(snapshots, paths, fps=args.fps)
            replace_output_dir(paths.root, output_dir)

        revision = snapshots[-1].meta.revision
        print(
            json.dumps(
                {
                    "commit_count": len(snapshots),
                    "date_range": [snapshots[0].meta.date, snapshots[-1].meta.date],
                    "output_dir": str(output_dir),
                    "revision": revision,
                },
                sort_keys=True,
            )
        )
        return 0
    except LanguageHistoryError as error:
        print(f"language-history: {error}", file=sys.stderr)
        return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render a GitHub Linguist language-history animation for TuneForge.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for generated JSON, CSV, frames, GIF, and MP4 output.",
    )
    parser.add_argument(
        "--ref",
        default="HEAD",
        help="Git revision to analyze. Defaults to HEAD; use origin/main for the remote branch.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Fetch origin/main before resolving --ref. Does not check out or modify source files.",
    )
    parser.add_argument(
        "--render-only",
        action="store_true",
        help="Re-render existing Linguist snapshots without collecting history again.",
    )
    parser.add_argument("--fps", type=int, default=16, help="Animation frame rate. Defaults to 16.")
    return parser


def run_command(command: list[str], *, cwd: Path, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            cwd=cwd,
            text=True,
            capture_output=capture_output,
        )
    except FileNotFoundError as error:
        raise LanguageHistoryError(f"Required command was not found: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() if error.stderr else ""
        suffix = f": {detail}" if detail else ""
        raise LanguageHistoryError(f"Command failed: {' '.join(command)}{suffix}") from error


def resolve_revision(ref: str) -> str:
    result = run_command(
        ["git", "rev-parse", "--verify", f"{ref}^{{commit}}"],
        cwd=REPO_ROOT,
        capture_output=True,
    )
    return result.stdout.strip()


def write_commit_list(revision: str, output_path: Path) -> None:
    result = run_command(
        ["git", "log", "--first-parent", "--reverse", "--format=%H%x09%cs%x09%s", revision],
        cwd=REPO_ROOT,
        capture_output=True,
    )
    commits = result.stdout.strip()
    if not commits:
        raise LanguageHistoryError(f"No commits found for revision: {revision}")
    output_path.write_text(f"{commits}\n", encoding="utf-8")


def git_common_dir() -> Path:
    result = run_command(
        ["git", "rev-parse", "--git-common-dir"],
        cwd=REPO_ROOT,
        capture_output=True,
    )
    common_dir = Path(result.stdout.strip())
    return common_dir if common_dir.is_absolute() else (REPO_ROOT / common_dir).resolve()


def collect_linguist(paths: OutputPaths) -> None:
    common_dir = git_common_dir()
    mounts = [
        "-v",
        f"{REPO_ROOT}:{REPO_ROOT}",
        "-v",
        f"{common_dir}:{common_dir}",
    ]
    if not is_relative_to(paths.root, REPO_ROOT):
        mounts.extend(("-v", f"{paths.root}:{paths.root}"))
    collect_script = """set -eu
commits_file=\"$1\"
out_dir=\"$2\"
mkdir -p \"$out_dir\"
: > \"$out_dir/meta.tsv\"
total=\"$(wc -l < \"$commits_file\" | tr -d ' ')\"
tab=\"$(printf '\\t')\"
i=0
while IFS=\"$tab\" read -r rev date subject; do
  i=$((i + 1))
  short_rev=\"$(printf '%s' \"$rev\" | cut -c 1-8)\"
  printf '[%04d/%04d] %s %s\\n' \"$i\" \"$total\" \"$date\" \"$short_rev\" >&2
  github-linguist --rev \"$rev\" --json > \"$out_dir/$(printf '%04d' \"$i\").json\"
  printf '%s\\t%s\\t%s\\t%s\\n' \"$i\" \"$rev\" \"$date\" \"$subject\" >> \"$out_dir/meta.tsv\"
done < \"$commits_file\"
"""
    run_command(
        [
            "docker",
            "run",
            "--rm",
            "--platform",
            "linux/amd64",
            *mounts,
            "-w",
            str(REPO_ROOT),
            LINGUIST_IMAGE,
            "sh",
            "-c",
            collect_script,
            "language-history-collector",
            str(paths.commits),
            str(paths.snapshots),
        ],
        cwd=REPO_ROOT,
    )


def replace_output_dir(staged_dir: Path, output_dir: Path) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    staged_dir.replace(output_dir)


def copy_existing_inputs(source: OutputPaths, destination: OutputPaths) -> None:
    if not source.commits.is_file() or not source.snapshots.is_dir():
        raise LanguageHistoryError(
            "--render-only requires existing commits.tsv and linguist-json output in the output directory."
        )
    shutil.copy2(source.commits, destination.commits)
    shutil.copytree(source.snapshots, destination.snapshots)


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    for font_path in FONT_BOLD_PATHS if bold else FONT_REGULAR_PATHS:
        try:
            return ImageFont.truetype(font_path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def color_for(language: str) -> str:
    if language in COLORS:
        return COLORS[language]
    digest = hashlib.sha256(language.encode("utf-8")).digest()
    return FALLBACK_COLORS[digest[0] % len(FALLBACK_COLORS)]


def load_snapshots(directory: Path) -> list[Snapshot]:
    metadata = load_metadata(directory / "meta.tsv")
    snapshots: list[Snapshot] = []
    for path in sorted(directory.glob("*.json"), key=lambda item: int(item.stem)):
        index = int(path.stem)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise LanguageHistoryError(f"Invalid Linguist JSON: {path}") from error
        if index not in metadata:
            raise LanguageHistoryError(f"Linguist metadata is missing snapshot {index}.")
        snapshots.append(Snapshot(meta=metadata[index], languages=parse_languages(payload, path)))
    if not snapshots:
        raise LanguageHistoryError(f"No Linguist snapshots were produced in: {directory}")
    return snapshots


def load_metadata(path: Path) -> dict[int, CommitMeta]:
    metadata: dict[int, CommitMeta] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        index, revision, date, subject = line.split("\t", 3)
        parsed_index = int(index)
        metadata[parsed_index] = CommitMeta(
            index=parsed_index,
            revision=revision,
            date=date,
            subject=subject,
        )
    return metadata


def parse_languages(payload: object, path: Path) -> tuple[LanguageStat, ...]:
    if not isinstance(payload, dict):
        raise LanguageHistoryError(f"Linguist JSON must contain a language object: {path}")
    languages: list[LanguageStat] = []
    for language, values in payload.items():
        if not isinstance(language, str) or not isinstance(values, dict):
            raise LanguageHistoryError(f"Invalid language entry in: {path}")
        size = values.get("size")
        percentage = values.get("percentage")
        if not isinstance(size, int) or isinstance(size, bool):
            raise LanguageHistoryError(f"Invalid language values in: {path}")
        try:
            parsed_percentage = float(percentage)
        except (TypeError, ValueError) as error:
            raise LanguageHistoryError(f"Invalid language values in: {path}") from error
        if not math.isfinite(parsed_percentage):
            raise LanguageHistoryError(f"Invalid language values in: {path}")
        languages.append(LanguageStat(language=language, size=size, percentage=parsed_percentage))
    return tuple(sorted(languages, key=lambda item: item.size, reverse=True))


def history_languages(snapshots: list[Snapshot]) -> list[str]:
    latest_sizes = {item.language: item.size for item in snapshots[-1].languages}
    names = {item.language for snapshot in snapshots for item in snapshot.languages}
    return sorted(names, key=lambda language: (-latest_sizes.get(language, 0), language.casefold()))


def history_values(snapshots: Iterable[Snapshot], language: str) -> list[float]:
    return [
        next((item.percentage for item in snapshot.languages if item.language == language), 0.0)
        for snapshot in snapshots
    ]


def text_width(draw: ImageDraw.ImageDraw, value: str, text_font: ImageFont.ImageFont) -> int:
    box = draw.textbbox((0, 0), value, font=text_font)
    return box[2] - box[0]


def truncate(draw: ImageDraw.ImageDraw, value: str, text_font: ImageFont.ImageFont, limit: int) -> str:
    if text_width(draw, value, text_font) <= limit:
        return value
    suffix = "..."
    while value and text_width(draw, value + suffix, text_font) > limit:
        value = value[:-1]
    return value + suffix


def draw_bar(draw: ImageDraw.ImageDraw, languages: tuple[LanguageStat, ...]) -> None:
    x, y, width, height = 48, 108, 804, 18
    draw.rounded_rectangle((x, y, x + width, y + height), radius=9, fill="#21262d")
    current_x = x
    for item in languages:
        segment_width = width * (item.percentage / 100.0)
        if segment_width < 1.5:
            continue
        draw.rectangle((current_x, y, current_x + segment_width, y + height), fill=color_for(item.language))
        current_x += segment_width


def draw_summary_legend(draw: ImageDraw.ImageDraw, languages: tuple[LanguageStat, ...]) -> None:
    positions = ((48, 174), (330, 174), (612, 174), (48, 228), (330, 228), (612, 228))
    regular = font(18)
    bold = font(18, bold=True)
    for item, (x, y) in zip(languages[:6], positions, strict=False):
        draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=color_for(item.language))
        draw.text((x + 18, y - 11), item.language, font=bold, fill=TEXT)
        offset = text_width(draw, item.language, bold) + 28
        draw.text((x + 18 + offset, y - 11), f"{item.percentage:.1f}%", font=regular, fill=MUTED)


def chart_scale(snapshots: list[Snapshot]) -> int:
    maximum = max((item.percentage for snapshot in snapshots for item in snapshot.languages), default=0.0)
    return max(40, int(math.ceil(maximum / 10.0) * 10))


def history_legend_height(language_count: int) -> int:
    return math.ceil(language_count / 5) * 26


def frame_height(snapshots: list[Snapshot]) -> int:
    return 658 + history_legend_height(len(history_languages(snapshots)))


def draw_history_chart(
    draw: ImageDraw.ImageDraw,
    snapshots: list[Snapshot],
    *,
    upto: int,
) -> None:
    x0, y0, width, height = 86, 400, 766, 204
    scale = chart_scale(snapshots)
    plotted = snapshots[:upto]
    names = history_languages(snapshots)
    small = font(13)

    draw.rounded_rectangle((48, 370, 852, 650), radius=8, fill=PANEL)
    draw.text((68, 382), "Language history", font=font(17, bold=True), fill=TEXT)
    draw.text((68, 632), "Linguist percentage by first-parent commit", font=small, fill=MUTED)

    for value in range(0, scale + 1, 10):
        y = y0 + height - (value / scale) * height
        draw.line((x0, y, x0 + width, y), fill=BORDER, width=1)
        label = f"{value}%"
        draw.text((x0 - 12 - text_width(draw, label, small), y - 7), label, font=small, fill=MUTED)
    draw.line((x0, y0, x0, y0 + height), fill=BORDER, width=1)
    draw.line((x0, y0 + height, x0 + width, y0 + height), fill=BORDER, width=1)

    total = max(1, len(snapshots) - 1)
    for tick in range(5):
        position = round((len(snapshots) - 1) * tick / 4)
        x = x0 + (position / total) * width
        draw.line((x, y0 + height, x, y0 + height + 4), fill=BORDER, width=1)
        label = str(position + 1)
        draw.text((x - text_width(draw, label, small) / 2, y0 + height + 8), label, font=small, fill=MUTED)

    for language in names:
        values = history_values(plotted, language)
        points = [
            (
                x0 + (position / total) * width,
                y0 + height - (value / scale) * height,
            )
            for position, value in enumerate(values)
        ]
        if len(points) >= 2:
            draw.line(points, fill=color_for(language), width=3, joint="curve")
        if points:
            x, y = points[-1]
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color_for(language), outline=PANEL, width=2)

    legend_y = 666
    for index, language in enumerate(names):
        column = index % 5
        row = index // 5
        x = 52 + column * 160
        y = legend_y + row * 26
        draw.line((x, y, x + 16, y), fill=color_for(language), width=3)
        draw.text((x + 24, y - 8), truncate(draw, language, small, 128), font=small, fill=MUTED)


def draw_frame(snapshots: list[Snapshot], snapshot: Snapshot) -> Image.Image:
    image = Image.new("RGB", (WIDTH, frame_height(snapshots)), BG)
    draw = ImageDraw.Draw(image)
    meta = snapshot.meta
    title_font = font(31, bold=True)
    meta_font = font(18)
    small_font = font(15)
    commit_font = font(17)

    draw.text((48, 27), "TuneForge languages over time", font=title_font, fill=TEXT)
    draw.text((48, 61), f"{meta.date} - {meta.revision[:8]}", font=meta_font, fill=MUTED)
    progress = f"{meta.index}/{len(snapshots)}"
    draw.text((852 - text_width(draw, progress, meta_font), 61), progress, font=meta_font, fill=MUTED)

    draw_bar(draw, snapshot.languages)
    draw_summary_legend(draw, snapshot.languages)

    draw.rounded_rectangle((48, 278, 852, 336), radius=8, fill=PANEL)
    draw.text((68, 292), "Commit", font=small_font, fill=MUTED)
    subject = truncate(draw, meta.subject, commit_font, 760)
    draw.text((68, 314), subject, font=commit_font, fill=TEXT)

    draw_history_chart(draw, snapshots, upto=meta.index)
    return image


def write_csv(snapshots: list[Snapshot], output_path: Path) -> None:
    languages = sorted({item.language for snapshot in snapshots for item in snapshot.languages})
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["index", "date", "rev", "subject", *languages])
        for snapshot in snapshots:
            percentages = {item.language: item.percentage for item in snapshot.languages}
            writer.writerow(
                [
                    snapshot.meta.index,
                    snapshot.meta.date,
                    snapshot.meta.revision,
                    snapshot.meta.subject,
                    *[f"{percentages.get(language, 0.0):.2f}" for language in languages],
                ]
            )


def render_frames(snapshots: list[Snapshot], output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_paths: list[Path] = []
    for snapshot in snapshots:
        path = output_dir / f"frame_{snapshot.meta.index:04d}.png"
        draw_frame(snapshots, snapshot).save(path)
        frame_paths.append(path)
    return frame_paths


def render_gif(frame_paths: list[Path], output_path: Path, *, fps: int) -> None:
    frames = [Image.open(path).convert("P", palette=Image.Palette.ADAPTIVE) for path in frame_paths]
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        duration=round(1000 / fps),
        loop=0,
        optimize=True,
    )


def render_mp4(frame_dir: Path, output_path: Path, *, fps: int) -> None:
    run_command(
        [
            "ffmpeg",
            "-y",
            "-framerate",
            str(fps),
            "-i",
            str(frame_dir / "frame_%04d.png"),
            "-vf",
            "format=yuv420p",
            str(output_path),
        ],
        cwd=REPO_ROOT,
    )


def render_artifacts(snapshots: list[Snapshot], paths: OutputPaths, *, fps: int) -> None:
    write_csv(snapshots, paths.csv)
    frame_paths = render_frames(snapshots, paths.frames)
    render_gif(frame_paths, paths.gif, fps=fps)
    render_mp4(paths.frames, paths.mp4, fps=fps)


if __name__ == "__main__":
    raise SystemExit(main())
