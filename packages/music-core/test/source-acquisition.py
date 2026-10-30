"""Offline acquisition and preparation contracts with tiny synthetic locked archives."""
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_sources", Path(__file__).parents[1] / "tools/prepare_sources.py")
prepare_sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_sources)


class AcquisitionContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "vendor/gingo-src"
        self.files = {"LICENSE": b"Synthetic MIT fixture\n", "cpp/src/core.cpp": b"canonical\n"}
        (self.root / "licenses").mkdir()
        (self.root / "licenses/Gingo-LICENSE").write_bytes(self.files["LICENSE"])
        self.archive = self.root / "archive.tar.gz"
        self.make_archive()
        self.lock = {"archive": {"url": "https://invalid.example/never", "sha256": prepare_sources.digest(self.archive)}, "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in self.files.items()], "patches": []}
        (self.root / "sources.lock.json").write_text(json.dumps(self.lock))
        self.cache = self.root / "build/cache/gingo" / self.lock["archive"]["sha256"] / "gingo.tar.gz"
        self.cache.parent.mkdir(parents=True)
        self.cache.write_bytes(self.archive.read_bytes())
        self.addCleanup(patch.stopall)
        patch.object(prepare_sources, "ROOT", self.root).start()
        patch.object(prepare_sources, "SOURCE", self.source).start()
        self.network = patch.object(prepare_sources.urllib.request, "urlopen", side_effect=AssertionError("offline must never download")).start()

    def make_archive(self, extra=None):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in self.files.items():
                item = tarfile.TarInfo("locked-revision/" + name)
                item.size = len(data)
                archive.addfile(item, io.BytesIO(data))
            if extra is not None:
                archive.addfile(extra)

    def test_offline_extracts_exact_inventory_and_prepares_without_network(self):
        prepare_sources.acquire(offline=True)
        self.assertTrue(prepare_sources.validate_tree(self.source, self.lock["files"]))
        destination = self.root / "build/cmake/gingo"
        prepare_sources.prepare(destination)
        self.assertTrue(prepare_sources.validate_tree(destination, self.lock["files"]))
        (destination / "unexpected").write_text("stale")
        prepare_sources.prepare(destination)
        self.assertFalse((destination / "unexpected").exists())
        self.network.assert_not_called()

    def test_missing_cache_fails_offline_or_accepts_verified_sdist_sources(self):
        self.cache.unlink()
        with self.assertRaisesRegex(ValueError, "unavailable offline"):
            prepare_sources.acquire(offline=True)
        with self.assertRaisesRegex(ValueError, "--fetch-sources"):
            prepare_sources.prepare(self.root / "build/gingo")
        for name, data in self.files.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        prepare_sources.acquire(offline=True)
        self.network.assert_not_called()

    def test_corrupt_archive_fails_even_with_prepared_sources(self):
        prepare_sources.acquire(offline=True)
        self.cache.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum"):
            prepare_sources.acquire(offline=True)

    def test_corrupt_or_extra_source_is_replaced_from_verified_archive(self):
        prepare_sources.acquire(offline=True)
        (self.source / "LICENSE").write_bytes(b"changed")
        (self.source / "extra").write_bytes(b"extra")
        prepare_sources.acquire(offline=True)
        self.assertTrue(prepare_sources.validate_tree(self.source, self.lock["files"]))

    def test_traversal_and_locked_symlink_are_rejected_without_partial_install(self):
        for name in ["../escape", "locked-revision/cpp/src/core.cpp"]:
            with self.subTest(name=name):
                extra = tarfile.TarInfo(name)
                extra.type = tarfile.SYMTYPE
                extra.linkname = "../../outside"
                self.make_archive(extra)
                self.lock["archive"]["sha256"] = prepare_sources.digest(self.archive)
                (self.root / "sources.lock.json").write_text(json.dumps(self.lock))
                cache = self.root / "build/cache/gingo" / self.lock["archive"]["sha256"] / "gingo.tar.gz"
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(self.archive.read_bytes())
                with self.assertRaises(ValueError):
                    prepare_sources.acquire(offline=True)
                self.assertFalse(self.source.exists())

    def test_patch_context_and_locked_output_are_verified(self):
        prepare_sources.acquire(offline=True)
        patch_file = self.root / "owned.patch"
        patch_file.write_text("--- a/cpp/src/core.cpp\n+++ b/cpp/src/core.cpp\n@@ -1 +1 @@\n-canonical\n+patched\n")
        self.lock["patches"] = [{"path": "owned.patch", "sha256": prepare_sources.digest(patch_file), "outputs": [{"path": "cpp/src/core.cpp", "sha256": hashlib.sha256(b"patched\n").hexdigest()}]}]
        (self.root / "sources.lock.json").write_text(json.dumps(self.lock))
        destination = self.root / "build/gingo"
        prepare_sources.prepare(destination)
        self.assertEqual((destination / "cpp/src/core.cpp").read_bytes(), b"patched\n")
        self.assertEqual((self.source / "cpp/src/core.cpp").read_bytes(), b"canonical\n")
        self.lock["patches"][0]["outputs"][0]["sha256"] = "0" * 64
        (self.root / "sources.lock.json").write_text(json.dumps(self.lock))
        with self.assertRaisesRegex(ValueError, "locked patch output"):
            prepare_sources.prepare(destination)


if __name__ == "__main__":
    unittest.main()
