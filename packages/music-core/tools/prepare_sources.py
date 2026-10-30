"""Verify pinned sources and apply the owned unified patch in a build directory."""

import argparse
import hashlib
import json
import re
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_patch(destination: Path, text: str) -> None:
    lines = text.splitlines(keepends=True)
    index = 0
    while index < len(lines):
        if not lines[index].startswith("--- a/"):
            raise ValueError("Unexpected patch file header")
        name = lines[index][6:].rstrip("\n")
        index += 1
        if index >= len(lines) or lines[index] != "+++ b/" + name + "\n":
            raise ValueError("Patch must update an existing same-name file")
        index += 1
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Patch path escapes build directory")
        target = destination / relative
        original = target.read_text(encoding="utf-8").splitlines(keepends=True)
        output: list[str] = []
        cursor = 0
        while index < len(lines) and lines[index].startswith("@@ "):
            header = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*\n", lines[index])
            if header is None:
                raise ValueError("Invalid patch hunk")
            start = int(header[1]) - 1
            if start < cursor or start > len(original):
                raise ValueError("Patch hunk outside source")
            output.extend(original[cursor:start])
            cursor = start
            index += 1
            consumed = produced = 0
            while index < len(lines) and not lines[index].startswith(("@@ ", "--- a/")):
                line = lines[index]
                index += 1
                marker, body = line[0], line[1:]
                if marker in " -":
                    if cursor >= len(original) or original[cursor] != body:
                        raise ValueError("Patch context differs from pinned source")
                    cursor += 1
                    consumed += 1
                if marker in " +":
                    output.append(body)
                    produced += 1
                if marker not in " +-":
                    raise ValueError("Unsupported patch marker")
            if consumed != int(header[2] or 1) or produced != int(header[4] or 1):
                raise ValueError("Patch hunk length mismatch")
        output.extend(original[cursor:])
        target.write_text("".join(output), encoding="utf-8")


SOURCE = ROOT / "vendor/gingo-src"
GUIDANCE = "Run node scripts/build-music-core.mjs --fetch-sources [--offline] from the repository root."


def locked_sources() -> dict:
    return json.loads((ROOT / "sources.lock.json").read_text(encoding="utf-8"))


def validate_tree(source: Path, files: list[dict]) -> bool:
    if not source.is_dir() or source.is_symlink():
        return False
    expected = {file["path"] for file in files}
    actual = set()
    for path in source.rglob("*"):
        if path.is_symlink():
            return False
        if path.is_file():
            actual.add(path.relative_to(source).as_posix())
    return actual == expected and all(
        digest(source / file["path"]) == file["sha256"]
        and ("bytes" not in file or (source / file["path"]).stat().st_size == file["bytes"])
        for file in files
    )


def replace_tree(temporary: Path, destination: Path) -> None:
    old = destination.with_name(destination.name + ".previous")
    if old.exists():
        shutil.rmtree(old)
    if destination.exists():
        destination.rename(old)
    try:
        temporary.rename(destination)
    except BaseException:
        if old.exists():
            old.rename(destination)
        raise
    if old.exists():
        shutil.rmtree(old)


def acquire(offline: bool = False) -> None:
    lock = locked_sources()
    cache = ROOT / "build/cache/gingo" / lock["archive"]["sha256"]
    archive = cache / "gingo.tar.gz"
    if archive.exists() and (archive.is_symlink() or digest(archive) != lock["archive"]["sha256"]):
        raise ValueError("Cached Gingo archive checksum differs from its pin")
    if not archive.exists():
        # A verified standalone sdist already contains the exact locked sources.
        if offline and validate_tree(SOURCE, lock["files"]):
            return
        if offline:
            raise ValueError("Pinned Gingo archive is unavailable offline. " + GUIDANCE)
        cache.mkdir(parents=True, exist_ok=True)
        temporary = cache / "gingo.tar.gz.partial"
        try:
            with urllib.request.urlopen(lock["archive"]["url"], timeout=60) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if digest(temporary) != lock["archive"]["sha256"]:
                raise ValueError("Downloaded Gingo archive checksum differs from its pin")
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    if validate_tree(SOURCE, lock["files"]):
        return
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".gingo-", dir=SOURCE.parent))
    try:
        expected = {file["path"] for file in lock["files"]}
        seen = set()
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle:
                name = Path(member.name)
                if name.is_absolute() or ".." in name.parts or "\\" in member.name:
                    raise ValueError("Unsafe Gingo archive path")
                if len(name.parts) < 2:
                    continue
                relative = Path(*name.parts[1:]).as_posix()
                if relative not in expected:
                    continue
                if not member.isfile() or relative in seen:
                    raise ValueError("Gingo archive contains a nonregular or duplicate locked source")
                seen.add(relative)
                target = temporary / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
        if seen != expected or not validate_tree(temporary, lock["files"]):
            raise ValueError("Extracted Gingo sources differ from locked cpp and LICENSE inventory")
        replace_tree(temporary, SOURCE)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def prepare(destination: Path) -> None:
    destination = destination.resolve()
    if destination == SOURCE or SOURCE in destination.parents or destination in SOURCE.parents:
        raise ValueError("Build output overlaps locked source")
    lock = locked_sources()
    if digest(ROOT / "licenses/Gingo-LICENSE") != next(file["sha256"] for file in lock["files"] if file["path"] == "LICENSE"):
        raise ValueError("Distributed Gingo license differs from lock")
    if not validate_tree(SOURCE, lock["files"]):
        raise ValueError("Verified Gingo sources are missing or changed. " + GUIDANCE)
    for file in lock.get("unicode", {}).get("files", []):
        if digest(ROOT / file["path"]) != file["sha256"]:
            raise ValueError("Pinned Unicode artifact changed: " + file["path"])
    expected = {file["path"]: file["sha256"] for file in lock["files"]}
    for patch in lock["patches"]:
        if digest(ROOT / patch["path"]) != patch["sha256"]:
            raise ValueError("Owned patch changed")
        expected.update({file["path"]: file["sha256"] for file in patch["outputs"]})
    prepared = [{"path": name, "sha256": sha} for name, sha in expected.items()]
    if validate_tree(destination, prepared):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".prepared-gingo-", dir=destination.parent))
    try:
        shutil.copytree(SOURCE, temporary, dirs_exist_ok=True)
        for patch in lock["patches"]:
            apply_patch(temporary, (ROOT / patch["path"]).read_text(encoding="utf-8"))
        if not validate_tree(temporary, prepared):
            raise ValueError("Prepared source differs from locked patch output")
        replace_tree(temporary, destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--fetch-sources", action="store_true")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    if args.fetch_sources:
        acquire(args.offline)
    elif args.offline or args.destination is None:
        parser.error("Use --fetch-sources [--offline], or a CMake preparation destination")
    else:
        prepare(args.destination)
