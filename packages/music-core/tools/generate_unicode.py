"""Maintenance-only generator for the legacy Python Unicode16 parsing policy.

Run with CPython3.14 and an explicit directory containing the three pinned UCD
files. Builds consume the generated header and never invoke this generator.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import platform
import sys
import unicodedata

VERSION = "16.0.0"
BASE = f"https://www.unicode.org/Public/{VERSION}/ucd/"
SOURCES = {
    "UnicodeData.txt": "ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f",
    "DerivedCoreProperties.txt": "39d35161f2954497f69e08bdb9e701493f476a3d30222de20028feda36c1dabd",
    "SpecialCasing.txt": "8d5de354eef79f2395a54c9c7dcebbaf3d30fc962d0f85611ea97aa973a0c451",
}
LICENSE_SHA256 = "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"


def ranges(points: set[int]) -> list[tuple[int, int]]:
    output: list[tuple[int, int]] = []
    for point in sorted(points):
        if output and point == output[-1][1] + 1:
            output[-1] = output[-1][0], point
        else:
            output.append((point, point))
    return output


def mapping_ranges(mapping: dict[int, int]) -> list[tuple[int, int, int, int]]:
    pairs = sorted((point, target - point) for point, target in mapping.items())
    output = []
    index = 0
    while index < len(pairs):
        first, delta = pairs[index]
        last, step = first, 1
        if index + 1 < len(pairs) and pairs[index + 1][1] == delta:
            difference = pairs[index + 1][0] - first
            if difference in (1, 2):
                step = difference
        end = index + 1
        while end < len(pairs) and pairs[end] == (last + step, delta):
            last = pairs[end][0]
            end += 1
        output.append((first, last, step, delta))
        index = end
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ucd-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "resources/unicode-v16.hpp")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if platform.python_implementation() != "CPython" or sys.version_info[:2] != (3, 14) or unicodedata.unidata_version != VERSION:
        raise SystemExit("Unicode generation requires CPython3.14 with UCD16.0.0")
    source_text = {}
    for name, expected in SOURCES.items():
        contents = (args.ucd_dir / name).read_bytes()
        if hashlib.sha256(contents).hexdigest() != expected:
            raise SystemExit(f"Pinned Unicode source hash mismatch: {name}")
        source_text[name] = contents.decode("utf-8")
    license_path = Path(__file__).resolve().parents[1] / "licenses/Unicode-LICENSE"
    if hashlib.sha256(license_path.read_bytes()).hexdigest() != LICENSE_SHA256:
        raise SystemExit("Pinned complete Unicode license hash mismatch")
    lower: dict[int, int] = {}
    decimal_zero = set()
    python_whitespace = set()
    for line in source_text["UnicodeData.txt"].splitlines():
        fields = line.split(";")
        point = int(fields[0], 16)
        if fields[13]:
            lower[point] = int(fields[13], 16)
        if fields[6] == "0":
            decimal_zero.add(point)
        if fields[2] == "Zs" or fields[4] in {"WS", "B", "S"}:
            python_whitespace.add(point)
    properties: dict[str, set[int]] = {"Cased": set(), "Case_Ignorable": set()}
    for line in source_text["DerivedCoreProperties.txt"].splitlines():
        content = line.split("#", 1)[0].strip()
        if not content:
            continue
        interval, property_name, *_ = [part.strip() for part in content.split(";")]
        if property_name not in properties:
            continue
        bounds = interval.split("..")
        first, last = int(bounds[0], 16), int(bounds[-1], 16)
        properties[property_name].update(range(first, last + 1))
    expansions = []
    for line in source_text["SpecialCasing.txt"].splitlines():
        content = line.split("#", 1)[0].strip()
        if not content:
            continue
        fields = [part.strip() for part in content.split(";")]
        if fields[4]:
            continue
        point = int(fields[0], 16)
        targets = [int(part, 16) for part in fields[1].split()]
        if len(targets) == 1:
            if targets[0] != point:
                lower[point] = targets[0]
        else:
            if len(targets) != 2:
                raise SystemExit("Unexpected lowercase expansion width")
            expansions.append((point, *targets))
            lower.pop(point, None)
    # Independently verify generated tables against the required interpreter.
    for point in range(0x110000):
        character = chr(point)
        targets = next((entry[1:] for entry in expansions if entry[0] == point), (lower.get(point, point),))
        if "".join(map(chr, targets)) != character.lower():
            raise SystemExit(f"Python/UCD lowercase mismatch: U+{point:04X}")
        if (point in python_whitespace) != character.isspace():
            raise SystemExit(f"Python/UCD whitespace mismatch: U+{point:04X}")
        if (point in properties["Cased"]) != (character.islower() or character.isupper() or character.istitle()):
            raise SystemExit(f"Python/UCD cased mismatch: U+{point:04X}")
    output = ["// Generated by tools/generate_unicode.py; do not edit.", "// CPython3.14; UCD16.0.0; Unicode LicenseV3 (licenses/Unicode-LICENSE)."]
    output.append(f"// Generator SHA256: {hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}")
    for name, digest in SOURCES.items():
        output.extend([f"// Source: {BASE}{name}", f"// SHA256: {digest}"])
    output.extend([f"// License SHA256: {LICENSE_SHA256}", "#pragma once", "namespace tuneforge::unicode_v16 {", "struct Range { unsigned first, last; };", "struct Mapping { unsigned first, last, step; int delta; };", "struct Expansion { unsigned point, first, second; };"])
    tables = [
        ("Mapping", "lowercase", mapping_ranges(lower)),
        ("Expansion", "lowercase_expansions", expansions),
        ("Range", "cased", ranges(properties["Cased"])),
        ("Range", "case_ignorable", ranges(properties["Case_Ignorable"])),
        ("Range", "decimal_digits", [(point, point + 9) for point in sorted(decimal_zero)]),
        ("Range", "python_whitespace", ranges(python_whitespace)),
    ]
    for kind, name, rows in tables:
        output.append(f"inline constexpr {kind} {name}[] = {{")
        output.extend("  {" + ", ".join(str(value) for value in row) + "}," for row in rows)
        output.append("};")
    output.append("} // namespace tuneforge::unicode_v16")
    generated = "\n".join(output) + "\n"
    if args.check:
        if args.output.read_text() != generated:
            raise SystemExit("Generated Unicode policy header drift")
    else:
        args.output.write_text(generated)
    print(f"Unicode{VERSION}; CPython{platform.python_version()}; generated SHA256 {hashlib.sha256(generated.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
