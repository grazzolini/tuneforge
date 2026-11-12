"""Build the weight-free Android Demucs runtime from verified source inputs."""
import argparse
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import ssl
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

sys.dont_write_bytecode = True

from exact_safetensors import EXPECTED as CHECKPOINT_SHA256

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "runtime-lock.json").read_text())
SYSTEM = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libvulkan.so", "libz.so"}
FORBIDDEN = re.compile(r"(?:readline|libhistory|gdbm|_dbm|_gdbm|liblzma|libzstd|_lzma|_zstd|torchaudio|tqdm|valgrind)", re.I)
COPYLEFT = re.compile(rb"GNU (?:LESSER |AFFERO )?GENERAL PUBLIC LICENSE|SPDX-License-Identifier:\s*(?:[AL]?GPL|MPL)-|Mozilla[ ]Public[ ]License", re.I)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, output):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                shutil.copyfileobj(response, output)
            return
        except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLEOFError, http.client.IncompleteRead) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code not in {500, 502, 503, 504}:
                raise
            if isinstance(error, urllib.error.URLError) and isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            if attempt == 2:
                raise
            output.seek(0)
            output.truncate()
            time.sleep(attempt + 1)


def fetch(spec, cache, offline):
    url = spec.get("url", spec.get("Origin"))
    expected = spec.get("sha256", spec.get("SHA256"))
    name = spec.get("file", url.rsplit("/", 1)[-1])
    file = cache / (expected[:16] + "-" + name if name == "build.sh" else name)
    if file.is_file() and file_digest(file) == expected:
        return file
    if offline:
        raise ValueError(f"Missing or invalid offline input: {file.name}")
    with tempfile.NamedTemporaryFile(prefix=".download-", dir=cache, delete=False) as temporary:
        staged = Path(temporary.name)
        try:
            download(url, temporary)
            temporary.flush()
            if file_digest(staged) != expected:
                raise ValueError(f"Input hash mismatch: {file.name}")
            os.fsync(temporary.fileno())
            staged.replace(file)
        finally:
            staged.unlink(missing_ok=True)
    return file


def model_asset():
    manifest = json.loads((HERE.parent / "demucs/models.json").read_text())
    model = next(model for model in manifest["models"] if model["id"] == "htdemucs_6s")
    signature, = model["bag_order"]
    weights = next(file for file in model["files"] if file["file_name"] == signature + ".safetensors")
    if weights["sha256"] != CHECKPOINT_SHA256:
        raise ValueError("Canonical model differs from the Android safetensors reader contract")
    name = weights["file_name"]
    return {"family": "demucs", "revision": model["revision"], "fileName": name,
            "url": f"https://huggingface.co/{model['repo_id']}/resolve/{model['revision']}/{name}",
            "size": weights["size"], "sha256": weights["sha256"], "relativePath": f"models/demucs/{name}"}


def build_openblas(args, cache, staging):
    spec = LOCK["ownedOpenblas"]
    archive = fetch({"url": spec["sourceUrl"], "sha256": spec["sourceSha256"],
                     "file": spec["sourceFile"]}, cache, args.offline)
    source_root = staging / "openblas-source"
    source_root.mkdir()
    with tarfile.open(archive) as package:
        package.extractall(source_root, filter="data")
    source = source_root / ("OpenBLAS-" + spec["version"])
    license_file = source / "LICENSE"
    if file_digest(license_file) != spec["licenseSha256"]:
        raise ValueError("OpenBLAS license differs from the pinned source")
    ndk = args.ndk.resolve()
    tools = args.readelf.absolute().parent
    if ndk / "toolchains/llvm/prebuilt" not in tools.parents:
        raise ValueError("Readelf must belong to the selected NDK")
    revision = re.search(r"^Pkg.Revision\s*=\s*([0-9.]+)\s*$",
                         (ndk / "source.properties").read_text(), re.M)
    if revision is None:
        raise ValueError("Missing stable Android NDK revision")
    build_root = staging / "openblas-build"
    flags = {
        "CMAKE_TOOLCHAIN_FILE": str(ndk / "build/cmake/android.toolchain.cmake"),
        "ANDROID_ABI": LOCK["abi"],
        "ANDROID_PLATFORM": f"android-{spec['androidApi']}",
        "CMAKE_BUILD_TYPE": "Release",
        "CMAKE_Fortran_COMPILER": "NOTFOUND",
        "TARGET": "ARMV8",
        "NUM_THREADS": "4",
        "USE_THREAD": "ON",
        "USE_OPENMP": "OFF",
        "DYNAMIC_ARCH": "OFF",
        "INTERFACE64": "OFF",
        "NO_AFFINITY": "ON",
        "BUILD_SHARED_LIBS": "ON",
        "BUILD_STATIC_LIBS": "OFF",
        "FIXED_LIBNAME": "ON",
        "C_LAPACK": "ON",
        "BUILD_TESTING": "OFF",
        "BUILD_BENCHMARKS": "OFF",
        "CMAKE_SHARED_LINKER_FLAGS": "-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -Wl,-z,now -Wl,-z,relro -Wl,--build-id=none",
        "CMAKE_C_FLAGS": shlex.quote(f"-ffile-prefix-map={staging}=."),
    }
    clean_env = dict(os.environ)
    for variable in ("CC", "CXX", "FC", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "FFLAGS", "LDFLAGS",
                     "CMAKE_GENERATOR", "CMAKE_TOOLCHAIN_FILE"):
        clean_env.pop(variable, None)
    configure = ["cmake", "-S", str(source), "-B", str(build_root), "-G", "Unix Makefiles"]
    subprocess.run([*configure, *(f"-D{key}={value}" for key, value in flags.items())],
                   env=clean_env, stdout=sys.stderr, check=True)
    command = ["cmake", "--build", str(build_root), "--target", "openblas_shared",
               "--parallel", str(min(6, os.cpu_count() or 1))]
    with tempfile.TemporaryFile() as log:
        result = subprocess.run(command, env=clean_env, stdout=log, stderr=subprocess.STDOUT, check=False)
        if result.returncode:
            log.seek(max(0, log.tell() - 8192))
            sys.stderr.write(log.read().decode(errors="replace"))
            result.check_returncode()
    library = build_root / "lib/libopenblas.so"
    subprocess.run([str(tools / "llvm-strip"), "--strip-unneeded", str(library)], check=True)
    library_bytes = neutralize_runpath(library.read_bytes())
    provenance = {
        "sourceUrl": spec["sourceUrl"], "sourceSha256": spec["sourceSha256"],
        "recipeSha256": file_digest(Path(__file__)), "openblasSha256": digest(library_bytes),
        "ndkRevision": revision[1], "generator": "Unix Makefiles",
        "compiler": subprocess.check_output([str(tools / "clang"), "--version"], text=True).splitlines()[0],
        "cmake": subprocess.check_output(["cmake", "--version"], text=True).splitlines()[0],
        "configureFlags": {key: value.replace(str(ndk), "${ANDROID_NDK_HOME}").replace(str(staging), "${BUILD_ROOT}")
                           for key, value in flags.items()},
        "buildTarget": "openblas_shared", "postProcessing": ["llvm-strip --strip-unneeded", "neutralize DT_RPATH/DT_RUNPATH"],
    }
    return library_bytes, license_file.read_bytes(), provenance


def regular_members(archive):
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Unsafe source archive path")
        if member.isfile():
            yield member, archive.extractfile(member).read()


def unpack_deb(file, root):
    content = file.read_bytes()
    if content[:8] != b"!<arch>\n":
        raise ValueError("Invalid Debian ar archive")
    offset = 8
    while offset + 60 <= len(content):
        header = content[offset:offset + 60]
        size = int(header[48:58])
        name = header[:16].decode().strip().rstrip("/")
        data = content[offset + 60:offset + 60 + size]
        if name.startswith("data.tar"):
            break
        offset += 60 + size + size % 2
    else:
        raise ValueError("Debian data archive missing")
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member, data in regular_members(archive):
            parts = PurePosixPath(member.name).parts
            try:
                index = parts.index("usr")
            except ValueError:
                continue
            relative = Path(*parts[index + 1:])
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)


def neutralize_runpath(data):
    """Set DT_RPATH/DT_RUNPATH string offsets to the ELF null string.

    Preserve code, symbols and all notices; only dynamic-loader policy changes.
    Explicit LD_LIBRARY_PATH supplies the verified runtime dependency closure.
    """
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Expected ELF64 little endian")
    data = bytearray(data)
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    for i in range(phnum):
        header = phoff + i * phsize
        if struct.unpack_from("<I", data, header)[0] != 2:
            continue
        offset, size = struct.unpack_from("<Q", data, header + 8)[0], struct.unpack_from("<Q", data, header + 32)[0]
        for pos in range(offset, offset + size, 16):
            tag = struct.unpack_from("<q", data, pos)[0]
            if tag in {15, 29}:
                struct.pack_into("<Q", data, pos + 8, 0)
    return bytes(data)


def needed(file, readelf):
    output = subprocess.check_output([str(readelf), "-d", str(file)], text=True)
    return re.findall(r"\(NEEDED\).*?\[([^\]]+)\]", output)


def include_python(relative):
    # Torch requires this exact internal manager path while initializing its
    # extension, even though the single-process eager worker never shares tensors.
    if relative.as_posix() == "site-packages/torch/bin/torch_shm_manager":
        return True
    parts = relative.parts
    if any(part in {"test", "tests", "__pycache__", "include", "bin", "cmake", "benchmark", "benchmarks", "dbm", "zstd"} for part in parts):
        return False
    if FORBIDDEN.search(str(relative)) or relative.suffix in {".pyc", ".a", ".o", ".lo", ".la", ".h", ".hpp", ".c", ".cpp", ".pxd", ".pyi"}:
        return False
    if relative.name in {"lzma.py", "bz2.py"}:
        return False
    if relative.name.startswith(("_test", "_multiarray_tests", "_rational_tests", "_umath_tests", "_simd")):
        return False
    return True


def write_zip(destination, files):
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100600 << 16
            archive.writestr(info, data)


def build(args):
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    model = model_asset()
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Runtime output must not exist; use a fresh destination")
    with tempfile.TemporaryDirectory(prefix="demucs-curation-", dir=output.parent) as temporary:
        staging = Path(temporary)
        blas_bytes, blas_license, blas_provenance = build_openblas(args, cache, staging)
        prefix = staging / "upstream"
        for spec in LOCK["native"]:
            unpack_deb(fetch(spec, cache, args.offline), prefix)
        # The owned pthread implementation replaces the Termux single-thread ELF.
        (prefix / "lib/libopenblas.so").write_bytes(blas_bytes)
        site = prefix / "lib/python3.14/site-packages"
        for spec in LOCK["pure"]:
            file = fetch(spec, cache, args.offline)
            if file.suffix == ".whl":
                with zipfile.ZipFile(file) as archive:
                    for name in archive.namelist():
                        parts = PurePosixPath(name)
                        if parts.is_absolute() or ".." in parts.parts:
                            raise ValueError("Unsafe wheel path")
                        if not name.endswith("/"):
                            target = site / name
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(archive.read(name))
            else:
                with tarfile.open(file) as archive:
                    for member, data in regular_members(archive):
                        if "/src/markupsafe/" in member.name and member.name.endswith((".py", ".typed")):
                            target = site / "markupsafe" / member.name.split("/src/markupsafe/", 1)[1]
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(data)
                        elif member.name.endswith("/LICENSE.txt"):
                            target = site / "markupsafe/LICENSE.txt"
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(data)
        files = {}
        # Keep Python libraries and licenses, not package managers, development
        # headers, command-line programs or independently licensed optional tools.
        library = prefix / "lib/python3.14"
        for file in library.rglob("*"):
            relative = file.relative_to(library)
            if file.is_file() and include_python(relative):
                files["lib/python3.14/" + relative.as_posix()] = file.read_bytes()
        # The pinned Demucs numerical modules remain stock. Retain only the
        # constructor decorator; this profile never uses the legacy pickle API.
        names = {"__about__.py", "__init__.py", "compat.py", "apply.py", "demucs.py", "hdemucs.py", "htdemucs.py", "spec.py", "transformer.py", "utils.py", "wiener.py", "states.py"}
        source = fetch(LOCK["demucs"], cache, args.offline)
        with tarfile.open(source) as archive:
            for member, data in regular_members(archive):
                name = PurePosixPath(member.name).name
                if "/demucs_infer/" in member.name and name in names:
                    text = data.decode()
                    if name == "apply.py":
                        if text.count("import tqdm\n") != 1 or text.count("futures = tqdm.tqdm(futures, unit_scale=scale, ncols=120, unit='seconds')") != 1:
                            raise ValueError("Pinned progress adaptation no longer matches")
                        text = text.replace("import tqdm\n", "").replace("futures = tqdm.tqdm(futures, unit_scale=scale, ncols=120, unit='seconds')", "raise ValueError('Android headless worker requires progress=False')")
                    elif name == "states.py":
                        text = text[:text.index('"""')] + "import functools\n\n\n" + text[text.index("def capture_init(init):"):]
                    elif name == "compat.py":
                        # Package import aliases eagerly import audio/repo and
                        # their network/pickle/torchaudio dependencies. Numerical
                        # compatibility helpers are independent of those aliases.
                        text = text[:text.index('"""')] + text[text.index("import torch"):]
                        text = text[:text.index("# Module aliasing")] + text[text.index("def get_torch_arange"):]
                    files["worker/demucs_infer/" + name] = text.encode()
                elif name == "LICENSE" and len(PurePosixPath(member.name).parts) == 2:
                    files["licenses/demucs-infer-LICENSE"] = data
        for name in ["runner.py", "exact_safetensors.py", "metadata_decode.py"]:
            files["worker/" + name] = (HERE / name).read_bytes()
        for spec in LOCK["native"]:
            package = spec["Package"]
            for file in (prefix / "share/doc" / package).rglob("*"):
                if file.is_file():
                    files["licenses/termux/" + package + "/" + file.name] = file.read_bytes()
            recipe = {"url": spec["RecipeURL"], "sha256": spec["RecipeSHA256"]}
            # Recipes explain embedded/static build options; they are evidence,
            # not the sole authority for licenses of the packaged file content.
            files["licenses/termux-recipes/" + package + ".build.sh"] = fetch(recipe, cache, args.offline).read_bytes()
        files["licenses/openblas/LICENSE.OpenBLAS"] = blas_license
        files["licenses/openblas/provenance.json"] = (json.dumps(blas_provenance, indent=2) + "\n").encode()
        files["licenses/openblas/build_runtime.py"] = Path(__file__).read_bytes()
        # Compute transitive native closure of every included extension. Optional
        # stdlib modules with excluded dependencies are removed as a unit.
        candidates = {file.name: file for file in (prefix / "lib").glob("*.so*") if file.is_file()}
        candidates.update({file.name: file for file in (site / "torch/lib").glob("*.so") if file.is_file()})
        optional_modules = {"_bz2", "_ssl", "_hashlib", "_sqlite3", "_curses", "_curses_panel", "_crypt", "pyexpat"}
        for name in list(files):
            if name.endswith(".so") and any(Path(name).name.startswith(module + ".") for module in optional_modules):
                del files[name]
        files["lib/libpython3.14.so"] = (prefix / "lib/libpython3.14.so").read_bytes()
        files["lib/libandroid-support.so"] = (prefix / "lib/libandroid-support.so").read_bytes()
        for candidate in list(candidates.values()):
            dynamic = subprocess.check_output([str(args.readelf), "-d", str(candidate)], text=True)
            soname = re.search(r"\(SONAME\).*?\[([^\]]+)\]", dynamic)
            if soname:
                candidates[soname.group(1)] = candidate
        dependencies = {}
        pending = [name for name, data in files.items() if data.startswith(b"\x7fELF")]
        processed = set()
        while pending:
            name = pending.pop()
            if name in processed:
                continue
            processed.add(name)
            file = staging / "elf"
            file.write_bytes(files[name])
            required = needed(file, args.readelf)
            dependencies[name] = required
            for dependency in required:
                if FORBIDDEN.search(dependency):
                    raise ValueError(f"Forbidden ELF dependency in {name}: {dependency}")
                if dependency in SYSTEM:
                    continue
                if dependency not in candidates:
                    raise ValueError(f"Unresolved ELF dependency: {dependency} in {name}")
                key = next((existing for existing in files if Path(existing).name == dependency), "lib/" + dependency)
                # Torch needs its own module-relative libraries as well. Keep a
                # single root copy for all extension DT_NEEDED resolution.
                if key not in files:
                    files[key] = candidates[dependency].read_bytes()
                    pending.append(key)
        executable = neutralize_runpath((prefix / "bin/python3.14").read_bytes())
        for name in processed:
            files[name] = neutralize_runpath(files[name])
        findings = []
        for name, data in sorted(files.items()):
            if FORBIDDEN.search(name):
                raise ValueError(f"Forbidden packaged path: {name}")
            if COPYLEFT.search(data):
                findings.append(name)
        audit = {"version": 1, "elfDependencies": dict(sorted(dependencies.items())), "copyleftTextMatches": findings,
                 "limitations": "Text scan plus ELF closure and pinned recipe review; not complete legal clearance of upstream static binaries. Notices retained verbatim; no filename-based license approval.",
                 "removed": ["gdbm/readline consumers and libraries", "lzma/zstd consumers and libraries", "tqdm (MPL/MIT)", "pip/setuptools/CLI/headers/tests", "legacy Demucs network/audio/pickle loaders"],
                 "adaptations": ["DT_RUNPATH/DT_RPATH offsets set to ELF null string; explicit app-private LD_LIBRARY_PATH", "Demucs apply: reject progress=True, omit tqdm import", "Demucs states: retain capture_init only", "Demucs compat: numerical helpers only"]}
        files["licenses/runtime-audit.json"] = (json.dumps(audit, indent=2) + "\n").encode()
        files["licenses/runtime-lock.json"] = (HERE / "runtime-lock.json").read_bytes()
        output.mkdir(mode=0o700)
        write_zip(output / "runtime.zip", files)
        (output / "libtuneforge_demucs_python.so").write_bytes(executable)
        profile = LOCK["profile"]
        manifest = {
            "version": LOCK["version"], "profile": profile["name"], "abi": LOCK["abi"], "python": LOCK["python"],
            "threads": profile["torchThreads"], "interopThreads": profile["torchInteropThreads"],
            "blasThreads": profile["blasThreads"], "blasParallel": profile["blasParallel"],
            "variant": profile["variant"], "openblasSha256": blas_provenance["openblasSha256"],
            "runtimeSha256": file_digest(output / "runtime.zip"), "executableSha256": digest(executable),
            "modelSha256": model["sha256"], "lockSha256": file_digest(HERE / "runtime-lock.json"),
            "files": {name: {"size": len(data), "sha256": digest(data)} for name, data in sorted(files.items())},
        }
        descriptor = output / "manifest.json"
        descriptor.write_text(json.dumps(manifest, indent=2) + "\n")
        (output / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
        print(json.dumps({"manifestSha256": file_digest(descriptor), "runtimeSha256": manifest["runtimeSha256"],
                          "openblasSha256": manifest["openblasSha256"], "files": len(files)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ndk", type=Path, required=True)
    parser.add_argument("--readelf", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    build(parser.parse_args())
