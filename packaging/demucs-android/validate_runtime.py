"""Validate curated payload or final APK, including nested files and ELF closure."""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True

from build_runtime import COPYLEFT, FORBIDDEN, HERE, LOCK, SYSTEM, digest, file_digest, model_asset, needed


def validate_models(apk, expected_manifest_sha256):
    name = "assets/models/manifest.json"
    descriptor = apk.read(name)
    if digest(descriptor) != expected_manifest_sha256:
        raise ValueError("APK model manifest differs from verified staging")
    manifest = json.loads(descriptor)
    demucs = [spec for spec in manifest["assets"] if spec["family"] == "demucs"]
    expected = model_asset()
    if len(demucs) != 1 or any(demucs[0].get(key) != value for key, value in expected.items()):
        raise ValueError("APK Demucs descriptor differs from the canonical model manifest")
    paths = {name}
    for spec in manifest["assets"]:
        if type(spec.get("bundled")) is not bool:
            raise ValueError("APK model has invalid bundling metadata")
        if spec["bundled"]:
            model = "assets/" + spec["relativePath"]
            paths.add(model)
            if apk.getinfo(model).file_size != spec["size"] or digest(apk.read(model)) != spec["sha256"]:
                raise ValueError("APK bundled model failed size or SHA-256 verification")
    if {entry for entry in apk.namelist() if entry.startswith("assets/models/")} != paths:
        raise ValueError("APK contains unexpected model files")
    return demucs[0]["bundled"]


def validate(args):
    bundled = None
    if args.apk:
        with zipfile.ZipFile(args.apk) as apk:
            names = apk.namelist()
            if len(names) != len(set(names)):
                raise ValueError("Duplicate APK paths")
            bundled = validate_models(apk, args.expected_model_manifest_sha256)
            descriptor = apk.read("assets/demucs-runtime/manifest.json")
            runtime = apk.read("assets/demucs-runtime/runtime.zip")
            executable = apk.read("lib/arm64-v8a/libtuneforge_demucs_python.so")
    else:
        descriptor = (args.root / "manifest.json").read_bytes()
        runtime = (args.root / "runtime.zip").read_bytes()
        executable = (args.root / "libtuneforge_demucs_python.so").read_bytes()
    if digest(descriptor) != args.expected_manifest_sha256:
        raise ValueError("Runtime manifest differs from the trusted producer receipt")
    manifest = json.loads(descriptor)
    profile = LOCK["profile"]
    expected = {
        "version": LOCK["version"], "profile": profile["name"], "abi": LOCK["abi"], "python": LOCK["python"],
        "threads": profile["torchThreads"], "interopThreads": profile["torchInteropThreads"],
        "blasThreads": profile["blasThreads"], "blasParallel": profile["blasParallel"],
        "variant": profile["variant"], "lockSha256": file_digest(HERE / "runtime-lock.json"),
        "modelSha256": model_asset()["sha256"],
    }
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("Unexpected runtime profile")
    for data, field in [(runtime, "runtimeSha256"), (executable, "executableSha256")]:
        if hashlib.sha256(data).hexdigest() != manifest[field]:
            raise ValueError("Payload hash mismatch")
    files = {}
    copyleft = []
    reviewed = []
    with zipfile.ZipFile(io.BytesIO(runtime)) as archive:
        if len(archive.namelist()) != len(set(archive.namelist())) or set(archive.namelist()) != set(manifest["files"]):
            raise ValueError("Unexpected archive entries")
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            if path.is_absolute() or ".." in path.parts or FORBIDDEN.search(str(path)) or path.parts[0] == "model" or path.suffix == ".safetensors":
                raise ValueError(f"Forbidden runtime path: {path}")
            spec = manifest["files"][info.filename]
            if info.file_size != spec["size"] or info.file_size > 512 * 1024 * 1024:
                raise ValueError("Archive size mismatch")
            data = archive.read(info)
            if hashlib.sha256(data).hexdigest() != spec["sha256"]:
                raise ValueError("Runtime file hash mismatch")
            if COPYLEFT.search(data):
                if hashlib.sha256(data).hexdigest() in LOCK.get("reviewedNoticeHashes", {}):
                    reviewed.append(info.filename)
                else:
                    copyleft.append(info.filename)
            files[info.filename] = data
    manager = "lib/python3.14/site-packages/torch/bin/torch_shm_manager"
    # Derived from the locked python-torch archive with only the documented
    # RUNPATH neutralization. A coherent regenerated manifest cannot omit it.
    manager_sha256 = "a4f7cffa2eeff192a0697de98fcdcaad278eae47fb2bc4a25b45abdd07d30bf2"
    if manager not in files or hashlib.sha256(files[manager]).hexdigest() != manager_sha256:
        raise ValueError("Required Torch shared-memory manager is missing or differs from the pinned runtime")
    checked_out = {f"worker/{name}": HERE / name for name in
                   ("runner.py", "exact_safetensors.py", "metadata_decode.py")}
    checked_out["licenses/runtime-lock.json"] = HERE / "runtime-lock.json"
    checked_out["licenses/openblas/build_runtime.py"] = HERE / "build_runtime.py"
    for name, source in checked_out.items():
        if digest(files.get(name, b"")) != file_digest(source):
            raise ValueError(f"Runtime member differs from the checked-out source: {name}")
    blas_path = "lib/libopenblas.so"
    if blas_path not in files or digest(files[blas_path]) != manifest["openblasSha256"]:
        raise ValueError("Required rebuilt pthread OpenBLAS differs from the producer output")
    if hashlib.sha256(files.get("licenses/openblas/LICENSE.OpenBLAS", b"")).hexdigest() != LOCK["ownedOpenblas"]["licenseSha256"]:
        raise ValueError("Required rebuilt OpenBLAS license is missing or differs")
    provenance = json.loads(files["licenses/openblas/provenance.json"])
    if (provenance["sourceSha256"] != LOCK["ownedOpenblas"]["sourceSha256"]
            or provenance["recipeSha256"] != file_digest(HERE / "build_runtime.py")
            or provenance["openblasSha256"] != manifest["openblasSha256"]):
        raise ValueError("OpenBLAS provenance differs from pinned build inputs")
    if copyleft:
        # Never remove notices to satisfy this gate. Review the actual file and
        # replace or omit its independently optional component in the recipe.
        raise ValueError(f"Unreviewed copyleft text in curated files: {copyleft}")
    elf = {name: data for name, data in files.items() if data.startswith(b"\x7fELF")}
    elf["nativeLibraryDir/libtuneforge_demucs_python.so"] = executable
    closure = {}
    alignments = {}
    bundled_names = {PurePosixPath(name).name for name in elf}
    with tempfile.TemporaryDirectory(prefix="demucs-elf-audit-") as temporary:
        file = Path(temporary) / "object.so"
        for name, data in elf.items():
            file.write_bytes(data)
            output = subprocess.check_output([str(args.readelf), "-h", "-l", "-d", str(file)], text=True)
            if not re.search(r"Machine:\s+AArch64", output):
                raise ValueError(f"Runtime native object is not AArch64: {name}")
            loads = [int(value, 16) for value in re.findall(r"LOAD\s+[^\n]*\s0x([0-9a-f]+)\s*$", output, re.M | re.I)]
            if not loads or min(loads) < 16384:
                raise ValueError(f"Runtime native object lacks 16KiB LOAD alignment: {name}")
            alignments[name] = loads
            if "/data/data/com.termux" in output or "/data/user/0/com.termux" in output:
                raise ValueError(f"Active Termux dynamic-loader path: {name}")
            dependencies = needed(file, args.readelf)
            for dependency in dependencies:
                if dependency not in SYSTEM and dependency not in bundled_names:
                    raise ValueError(f"Unresolved ELF dependency: {name}: {dependency}")
                if FORBIDDEN.search(dependency):
                    raise ValueError(f"Forbidden ELF dependency: {dependency}")
            closure[name] = dependencies
    result = {"validated": True, "files": len(files), "elfObjects": len(elf), "runtimeSha256": manifest["runtimeSha256"],
              "copyleftTextMatches": copyleft, "reviewedNoticeMatches": reviewed, "requiredTorchManagerVerified": True, "rebuiltOpenblasVerified": True, "openblasProvenance": provenance, "bundledDemucsModel": bundled, "threadProfile": LOCK["profile"], "elfDependencies": closure, "elfLoadAlignments": alignments, "architecture": "AArch64", "minimumLoadAlignment": 16384,
              "scope": "Curated added runtime and native Python launcher; hashes, file content copyleft patterns, complete DT_NEEDED closure and neutralized active RUNPATH. Static embedded upstream code provenance still requires recipe/source/notice review; this is not complete legal clearance."}
    if args.report:
        args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ["validated", "files", "elfObjects", "runtimeSha256", "copyleftTextMatches", "bundledDemucsModel"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--root", type=Path)
    group.add_argument("--apk", type=Path)
    parser.add_argument("--readelf", type=Path, required=True)
    parser.add_argument("--expected-manifest-sha256", required=True)
    parser.add_argument("--expected-model-manifest-sha256")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.apk and not args.expected_model_manifest_sha256:
        parser.error("--apk requires --expected-model-manifest-sha256 from verified model staging")
    validate(args)
