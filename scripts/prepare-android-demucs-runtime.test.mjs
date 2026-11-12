import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanAndroidDemucsStaging, prepareAndroidDemucsRuntime } from "./prepare-android-demucs-runtime.mjs";
import { resolveJava } from "./package-android.mjs";

function project() {
  const androidDir = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-demucs-stage-"));
  const main = path.join(androidDir, "app/src/main");
  fs.mkdirSync(path.join(main, "assets/demucs-runtime"), { recursive: true });
  fs.mkdirSync(path.join(main, "jniLibs/arm64-v8a"), { recursive: true });
  fs.writeFileSync(path.join(main, "assets/demucs-runtime/runtime.zip"), "stale optional runtime");
  fs.writeFileSync(path.join(main, "jniLibs/arm64-v8a/libtuneforge_demucs_python.so"), "stale executable");
  fs.writeFileSync(path.join(main, "jniLibs/arm64-v8a/libtuneforge.so"), "owned app");
  fs.writeFileSync(path.join(androidDir, "app/build.gradle.kts"), "android { compileSdk = 35 }\n// TUNEFORGE-DEMUCS-PACKAGING-BEGIN\nandroid { packaging { jniLibs { useLegacyPackaging = true } } }\n// TUNEFORGE-DEMUCS-PACKAGING-END\n");
  fs.writeFileSync(path.join(main, "AndroidManifest.xml"), '<manifest>\n<!-- TUNEFORGE-DEMUCS-EXTRACTION -->\n<application android:extractNativeLibs="true" android:label="TuneForge"/>\n</manifest>\n');
  return { androidDir, main };
}

test("package staging scrubs research assets and keeps current payload outside the generated project", (t) => {
  const { androidDir, main } = project();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-demucs-payload-"));
  t.after(() => {
    fs.rmSync(androidDir, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  });
  const root = path.join(stagingRoot, "runtime");
  fs.mkdirSync(root);
  const descriptor = "trusted producer output";
  const manifestSha256 = crypto.createHash("sha256").update(descriptor).digest("hex");
  fs.writeFileSync(path.join(root, "manifest.json"), descriptor);
  fs.writeFileSync(path.join(root, "runtime.zip"), "runtime fixture");
  fs.writeFileSync(path.join(root, "libtuneforge_demucs_python.so"), "launcher fixture");
  cleanAndroidDemucsStaging(androidDir);
  assert.throws(() => prepareAndroidDemucsRuntime({ androidDir, stagingRoot,
    produce: () => ({ root, receipt: { manifestSha256: "0".repeat(64) } }),
  }), /differs from the producer receipt/);
  const stage = prepareAndroidDemucsRuntime({ androidDir, stagingRoot,
    produce: () => ({ root, receipt: { manifestSha256 } }),
  });
  assert.equal(fs.readFileSync(path.join(stage.assets, "runtime.zip"), "utf8"), "runtime fixture");
  assert.equal(fs.readFileSync(stage.executable, "utf8"), "launcher fixture");
  assert.equal(stage.env.TUNEFORGE_ANDROID_PACKAGE_STAGING, stagingRoot);
  assert.equal(fs.existsSync(path.join(main, "assets/demucs-runtime")), false);
  assert.equal(fs.existsSync(path.join(main, "jniLibs/arm64-v8a/libtuneforge_demucs_python.so")), false);
  assert.equal(fs.readFileSync(path.join(main, "jniLibs/arm64-v8a/libtuneforge.so"), "utf8"), "owned app");
  assert.match(fs.readFileSync(path.join(androidDir, "app/build.gradle.kts"), "utf8"),
    /System\.getenv\("TUNEFORGE_ANDROID_PACKAGE_STAGING"\)/);
  cleanAndroidDemucsStaging(androidDir);
  assert.doesNotMatch(fs.readFileSync(path.join(androidDir, "app/build.gradle.kts"), "utf8"), /DEMUCS|useLegacyPackaging/);
  assert.doesNotMatch(fs.readFileSync(path.join(main, "AndroidManifest.xml"), "utf8"), /DEMUCS|extractNativeLibs/);
  assert.match(fs.readFileSync(path.join(main, "AndroidManifest.xml"), "utf8"), /android:label="TuneForge"/);
});

test("native worker accepts only its canonical project/job staging paths", (context) => {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
    ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const platforms = path.join(sdk, "platforms");
  const jar = fs.existsSync(platforms) ? fs.readdirSync(platforms)
    .filter((name) => /^android-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)))
    .map((name) => path.join(platforms, name, "android.jar")).find((file) => fs.existsSync(file)) : undefined;
  let javaHome;
  try { javaHome = resolveJava().home; } catch {}
  const javac = javaHome ? path.join(javaHome, "bin/javac") : "javac";
  const java = javaHome ? path.join(javaHome, "bin/java") : "java";
  if (!jar || !javaHome) {
    context.skip("Requires Android SDK platform jar and a host JDK; APK smoke remains a separate gate.");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-demucs-paths-"));
  try {
    const harness = path.join(temporary, "DemucsPathCheck.java");
    fs.writeFileSync(harness, `import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

public final class DemucsPathCheck {
    private static Method validation;
    private static int passed;
    private static void check(File root, File input, File output, String job, boolean accept) throws Exception {
        try {
            validation.invoke(null, root, input.getPath(), output.getPath(), job);
            if (!accept) throw new AssertionError("Accepted forbidden path");
        } catch (InvocationTargetException error) {
            if (accept || !(error.getCause() instanceof IllegalStateException)
                || !"DEMUCS_PATH_OUTSIDE_APP".equals(error.getCause().getMessage())) throw error;
        }
        passed++;
    }
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName("com.tuneforge.desktop.DemucsRunner");
        validation = type.getDeclaredMethod("validateJobPaths", File.class, String.class, String.class, String.class);
        validation.setAccessible(true);
        Path fixture = Files.createTempDirectory("demucs-path-fixture-");
        try {
            File root = fixture.resolve("app").toFile();
            File job = new File(root, "projects/project_123/stems/.job_456");
            if (!job.mkdirs()) throw new AssertionError("fixture create failed");
            File input = new File(job, "input.wav");
            File output = new File(job, "native");
            check(root, input, output, "job_456", true);
            check(root, new File(root, "mobile.sqlite3"), output, "job_456", false);
            check(root, new File(root, "shared_prefs/input.wav"), output, "job_456", false);
            check(root, new File(root, "files/input.wav"), output, "job_456", false);
            check(root, new File(fixture.toFile(), "external/input.wav"), output, "job_456", false);
            check(root, input, output, "other_job", false);
            check(root, input, new File(root, "projects/project_other/stems/.job_456/native"), "job_456", false);
            check(root, input, new File(job, "other"), "job_456", false);
            Path external = fixture.resolve("external");
            Files.createDirectory(external);
            Files.createSymbolicLink(output.toPath(), external);
            check(root, input, output, "job_456", false);
            Files.delete(output.toPath());
            System.out.println("PASS " + passed + " canonical staging acceptance/rejection fixtures");
        } finally {
            try (java.util.stream.Stream<Path> paths = Files.walk(fixture)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.delete(path); } catch (Exception error) { throw new RuntimeException(error); }
                });
            }
        }
    }
}
`);
    const sources = ["InferenceLock.java", "ModelAssetDescriptor.java", "DemucsRunner.java"].map((name) => fileURLToPath(
      new URL(`../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/${name}`, import.meta.url)));
    const compiled = spawnSync(javac, ["-cp", jar, "-d", temporary, ...sources, harness], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const checked = spawnSync(java, ["-cp", [jar, temporary].join(path.delimiter), "DemucsPathCheck"], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /PASS 9 canonical staging acceptance\/rejection fixtures/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("runtime and APK validation reject coherent substitutions and leaked weights", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-demucs-audit-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const validator = fileURLToPath(new URL("../packaging/demucs-android/validate_runtime.py", import.meta.url));
  const code = `import argparse, io, json, pathlib, ssl, struct, sys, types, urllib.error, zipfile
from unittest.mock import Mock, patch
sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
from validate_runtime import validate, validate_models
from build_runtime import HERE, LOCK, digest, fetch, file_digest, model_asset
import exact_safetensors

root = pathlib.Path(sys.argv[2])
model = {**model_asset(), "bundled": False}
model_manifest = json.dumps({"version": 1, "assets": [model]}).encode()
base = {"version": LOCK["version"], "profile": LOCK["profile"]["name"], "variant": LOCK["profile"]["variant"],
        "abi": LOCK["abi"], "python": LOCK["python"], "threads": 4, "interopThreads": 1,
        "blasThreads": 1, "blasParallel": 1, "lockSha256": file_digest(HERE / "runtime-lock.json"),
        "modelSha256": model["sha256"]}
runtime = io.BytesIO()
files = {"worker/runner.py": b"coherently substituted worker"}
with zipfile.ZipFile(runtime, "w") as archive:
    for name, data in files.items():
        archive.writestr(name, data)
manifest = json.dumps({**base, "runtimeSha256": digest(runtime.getvalue()), "executableSha256": digest(b"elf"),
    "files": {name: {"size": len(data), "sha256": digest(data)} for name, data in files.items()}}).encode()
(root / "manifest.json").write_bytes(manifest)
(root / "runtime.zip").write_bytes(runtime.getvalue())
(root / "libtuneforge_demucs_python.so").write_bytes(b"elf")

def rejects(action, expected):
    try:
        action()
    except (ValueError, KeyError) as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("Invalid artifact accepted")

# Exercise the checkpoint envelope without adding native inference dependencies to CI.
class Array:
    def __init__(self, data, dtype):
        assert dtype == "<f2"
        self.values = struct.unpack("<" + "e" * (len(data) // 2), data)
    def reshape(self, shape):
        self.shape = tuple(shape)
        return self
    def copy(self):
        return self.shape, self.values

metadata = {"klass": "demucs.htdemucs.HTDemucs", "args": "[]", "kwargs": "{}"}
tensor = {"dtype": "F16", "shape": [2], "data_offsets": [0, 4]}
header = {"__metadata__": metadata, "sample": tensor}
pcm = struct.pack("<ee", 1.0, -2.0)

def checkpoint(header=header, data=pcm):
    encoded = json.dumps(header).encode()
    return struct.pack("<Q", len(encoded)) + encoded + data

def read_checkpoint(data, expected=None, loader=exact_safetensors.tensors):
    file = root / "checkpoint.safetensors"
    file.write_bytes(data)
    with patch.object(exact_safetensors, "EXPECTED", digest(data) if expected is None else expected):
        return loader(file)

constructor = Mock()
with patch.dict(sys.modules, {
    "numpy": types.SimpleNamespace(frombuffer=Array),
    "torch": types.SimpleNamespace(from_numpy=lambda array: array),
    "demucs_infer.htdemucs": types.SimpleNamespace(HTDemucs=constructor),
}):
    valid = checkpoint()
    state = {"sample": ((2,), (1.0, -2.0))}
    assert read_checkpoint(valid) == (metadata, state)
    rejects(lambda: read_checkpoint(valid, exact_safetensors.EXPECTED), "SHA-256 mismatch")
    rejects(lambda: read_checkpoint(valid[:-1] + b"!", digest(valid)), "SHA-256 mismatch")
    for data, error in [
        (b"short", "Truncated safetensors header"),
        (struct.pack("<Q", 1024 * 1024 + 1), "Unbounded safetensors header"),
        (struct.pack("<Q", 100) + b"{}", "Truncated safetensors header"),
        (checkpoint([]), "Invalid safetensors header"),
        (checkpoint({}), "Invalid safetensors header"),
        (checkpoint({**header, "sample": {}}), "Invalid tensor descriptor"),
        (checkpoint({**header, "sample": {**tensor, "data_offsets": [False, 4]}}), "Invalid tensor offsets"),
        (checkpoint({**header, "sample": {**tensor, "shape": "2"}}), "Invalid tensor shape"),
        (checkpoint({**header, "sample": {**tensor, "shape": [-2]}}), "Invalid tensor shape"),
        (checkpoint({**header, "sample": {**tensor, "dtype": "F32"}}), "Invalid tensor span or dtype"),
        (checkpoint({**header, "sample": {**tensor, "data_offsets": [2, 6]}}), "Invalid tensor span or dtype"),
        (checkpoint({**header, "sample": {**tensor, "data_offsets": [0, 2]}}), "Invalid tensor span or dtype"),
        (checkpoint(data=pcm[:-1]), "Truncated tensor"),
        (valid + b"!", "Trailing or omitted tensor bytes"),
    ]:
        rejects(lambda: read_checkpoint(data), error)
    assert read_checkpoint(valid, loader=exact_safetensors.load_model) is constructor.return_value
    constructor.assert_called_once_with()
    constructor.return_value.load_state_dict.assert_called_once_with(state, strict=True)
    for bad, error in [
        ({**metadata, "klass": "other.Model"}, "Unsupported construction"),
        ({**metadata, "extra": "[]"}, "Unsupported construction"),
        ({**metadata, "args": "{}"}, "Unsupported constructor argument containers"),
        ({**metadata, "kwargs": "[]"}, "Unsupported constructor argument containers"),
    ]:
        rejects(lambda: read_checkpoint(checkpoint({**header, "__metadata__": bad}),
            loader=exact_safetensors.load_model), error)
    assert constructor.call_count == 1

args = argparse.Namespace(root=root, apk=None, readelf="unused", expected_manifest_sha256=digest(b"trusted"))
rejects(lambda: validate(args), "trusted producer receipt")
args.expected_manifest_sha256 = digest(manifest)
rejects(lambda: validate(args), "Required Torch shared-memory manager")
(root / "runtime.zip").write_bytes(b"corrupt")
rejects(lambda: validate(args), "Payload hash mismatch")

def check_model_file(leaked, expected_sha=digest(model_manifest)):
    fixture = io.BytesIO()
    with zipfile.ZipFile(fixture, "w") as apk:
        apk.writestr("assets/models/manifest.json", model_manifest)
        if leaked:
            apk.writestr("assets/" + model["relativePath"], b"unexpected weights")
    with zipfile.ZipFile(fixture) as apk:
        return validate_models(apk, expected_sha)

assert check_model_file(False) is False
rejects(lambda: check_model_file(True), "unexpected model files")
rejects(lambda: check_model_file(False, digest(b"trusted")), "verified staging")
fake = {**model, "bundled": True, "size": 3, "sha256": digest(b"abc")}
with patch("validate_runtime.model_asset", return_value={key: value for key, value in fake.items() if key != "bundled"}):
    descriptor = json.dumps({"version": 1, "assets": [fake]}).encode()
    for data, valid in [(b"abc", True), (b"bad", False)]:
        fixture = io.BytesIO()
        with zipfile.ZipFile(fixture, "w") as apk:
            apk.writestr("assets/models/manifest.json", descriptor)
            apk.writestr("assets/" + fake["relativePath"], data)
        with zipfile.ZipFile(fixture) as apk:
            if valid:
                assert validate_models(apk, digest(descriptor))
            else:
                rejects(lambda: validate_models(apk, digest(descriptor)), "bundled model failed size or SHA-256")

class Interrupted(io.BytesIO):
    def read(self, size=-1):
        if self.tell():
            raise ssl.SSLEOFError("transient transport")
        return super().read(1)

input_spec = {"url": "https://fixture.invalid/input.tar.gz", "sha256": digest(b"pinned")}
with patch("build_runtime.time.sleep"), patch("build_runtime.urllib.request.urlopen",
        side_effect=[Interrupted(b"partial"), io.BytesIO(b"pinned")]) as transport:
    fetched = fetch(input_spec, root, False)
    assert transport.call_count == 2 and fetched.read_bytes() == b"pinned"
    fetched.unlink()
with patch("build_runtime.urllib.request.urlopen", return_value=io.BytesIO(b"wrong")) as transport:
    rejects(lambda: fetch(input_spec, root, False), "Input hash mismatch")
    assert transport.call_count == 1 and not fetched.exists()
with patch("build_runtime.urllib.request.urlopen",
        side_effect=urllib.error.HTTPError(input_spec["url"], 404, "not found", {}, None)) as transport:
    try:
        fetch(input_spec, root, False)
    except urllib.error.HTTPError:
        assert transport.call_count == 1 and not fetched.exists()
    else:
        raise AssertionError("Unexpected accepted HTTP 404")
print("runtime and model audit checks passed")
`;
  const checked = spawnSync("uv", ["run", "--no-project", "--python", "3.14", "python", "-B", "-c", code, validator, temporary], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /runtime and model audit checks passed/);
});

test("Android worker rejects drift from actual fixed Torch and pthread BLAS getters", () => {
  const worker = fileURLToPath(new URL("../packaging/demucs-android/runner.py", import.meta.url));
  const code = `import runpy, sys
check = runpy.run_path(sys.argv[1], run_name="thread_fixture")["thread_evidence"]
class Torch:
    threads = 4
    interop = 1
    def get_num_threads(self): return self.threads
    def get_num_interop_threads(self): return self.interop
class Blas:
    threads = 1
    parallel = 1
    def openblas_get_num_threads(self): return self.threads
    def openblas_get_parallel(self): return self.parallel
    def openblas_get_config(self): return b"OpenBLAS 0.3.34 NO_AFFINITY ARMV8"
torch, blas = Torch(), Blas()
assert check(torch, blas, "a" * 64)["threads"] == 4
for owner, field, value in [(torch,"threads",1), (torch,"interop",2), (blas,"threads",2), (blas,"parallel",0), (blas,"parallel",2)]:
    old = getattr(owner, field)
    setattr(owner, field, value)
    try:
        check(torch, blas, "a" * 64)
    except RuntimeError as error:
        assert str(error) == "DEMUCS_THREAD_CONFIGURATION_INVALID"
    else:
        raise AssertionError("Accepted thread/implementation drift")
    setattr(owner, field, old)
print("actual getter drift rejected")
`;
  const checked = spawnSync("uv", ["run", "--no-project", "--python", "3.14", "python", "-B", "-c", code, worker], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /getter drift rejected/);
});

test("Java model and runtime caches recover from interrupted or invalid acquisition", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-demucs-cache-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const java = resolveJava().home;
  const write = (name, content) => {
    const file = path.join(temporary, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const stubs = [
    write("android/content/Context.java", `package android.content;
public abstract class Context {
    public abstract java.io.File getDataDir();
    public abstract java.io.File getFilesDir();
    public abstract java.io.File getCacheDir();
    public abstract android.content.res.AssetManager getAssets();
    public abstract android.content.pm.ApplicationInfo getApplicationInfo();
}`),
    write("android/content/res/AssetManager.java", `package android.content.res;
public abstract class AssetManager {
    public abstract java.io.InputStream open(String path) throws java.io.IOException;
}`),
    write("android/content/pm/ApplicationInfo.java", `package android.content.pm;
public class ApplicationInfo { public String nativeLibraryDir; }`),
    write("android/util/Log.java", `package android.util;
public class Log {
    public static int i(String tag, String value) { return 0; }
    public static int w(String tag, String value) { return 0; }
}`),
    write("org/json/JSONObject.java", `package org.json;
import java.util.LinkedHashMap;
public class JSONObject {
    private final LinkedHashMap<String,Object> values = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String ignored) { throw new UnsupportedOperationException(); }
    public JSONObject put(String key, Object value) { values.put(key, value); return this; }
    public boolean has(String key) { return values.containsKey(key); }
    public int length() { return values.size(); }
    public java.util.Iterator<String> keys() { return values.keySet().iterator(); }
    public int optInt(String key, int fallback) { return fallback; }
    public String optString(String key, String fallback) { return fallback; }
    public JSONObject getJSONObject(String key) { return (JSONObject) values.get(key); }
    public JSONArray getJSONArray(String key) { return (JSONArray) values.get(key); }
    public boolean getBoolean(String key) { return (Boolean) values.get(key); }
    public String getString(String key) { return (String) values.get(key); }
    public int getInt(String key) { return ((Number) values.get(key)).intValue(); }
    public long getLong(String key) { return ((Number) values.get(key)).longValue(); }
    public double getDouble(String key) { return ((Number) values.get(key)).doubleValue(); }
}`),
    write("org/json/JSONArray.java", `package org.json;
public class JSONArray {
    public int length() { throw new UnsupportedOperationException(); }
    public JSONObject getJSONObject(int index) { throw new UnsupportedOperationException(); }
}`),
  ];
  const harness = write("DemucsCacheCheck.java", `package com.tuneforge.desktop;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.ToLongFunction;
import java.util.zip.*;
import org.json.JSONObject;

public class DemucsCacheCheck {
    private static final byte[] GOOD = {1, 2, 3};
    private static final byte[] BAD = {3, 2, 1};
    private static final AtomicBoolean STOP = new AtomicBoolean();
    private static int networkCalls;
    private static byte[] networkBytes = GOOD;
    private static String sha(byte[] bytes) throws Exception {
        return ModelAssetDescriptor.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static void require(boolean ok) {
        if (!ok) throw new AssertionError("Unexpected state");
    }
    interface Operation { void run() throws Exception; }
    private static void rejects(String code, Operation operation) throws Exception {
        try {
            operation.run();
            throw new AssertionError("Accepted: " + code);
        } catch (java.lang.reflect.InvocationTargetException wrapped) {
            require(code.equals(wrapped.getCause().getMessage()));
        } catch (IllegalStateException error) {
            require(code.equals(error.getMessage()));
        }
    }
    private static void model(File files) throws Exception {
        URL.setURLStreamHandlerFactory(protocol -> new URLStreamHandler() {
            protected URLConnection openConnection(URL url) {
                networkCalls++;
                return new HttpURLConnection(url) {
                    public void connect() {}
                    public void disconnect() {}
                    public boolean usingProxy() { return false; }
                    public int getResponseCode() { return 200; }
                    public long getContentLengthLong() { return networkBytes.length; }
                    public InputStream getInputStream() { return new ByteArrayInputStream(networkBytes); }
                };
            }
        });
        var model = new ModelAssetDescriptor("demucs", "fixture", "model.safetensors", "bundle",
            "https://fixture.invalid/model.safetensors", GOOD.length, sha(GOOD));
        var cached = model.cachedFile(files);
        require(!model.verifiedFile(cached));
        var bundle = (ModelAssetDescriptor.OpenAsset) () -> new ByteArrayInputStream(GOOD);
        require(model.verifiedBundle(bundle));
        var progress = new java.util.ArrayList<Integer>();
        model.prepare(files, bundle, STOP, "DEMUCS", progress::add);
        require(model.verifiedFile(cached) && networkCalls == 0 && progress.equals(java.util.List.of(100)));
        model.prepare(files, () -> { throw new AssertionError("Read bundle despite verified cache"); }, STOP,
            "DEMUCS", value -> {});
        Files.write(cached.toPath(), BAD);
        File temporary = new File(cached.getParentFile(), ".model.safetensors.download");
        Files.write(temporary.toPath(), BAD);
        rejects("DEMUCS_CANCELLED", () -> model.prepare(files, bundle, STOP, "DEMUCS", value -> STOP.set(true)));
        require(!model.verifiedFile(cached) && !temporary.exists() && networkCalls == 0);
        STOP.set(false);
        rejects("DEMUCS_MODEL_INTEGRITY_FAILED", () -> model.prepare(files, () -> new ByteArrayInputStream(BAD),
            STOP, "DEMUCS", value -> {}));
        require(!model.verifiedFile(cached) && !temporary.exists() && networkCalls == 0);
        var missing = (ModelAssetDescriptor.OpenAsset) () -> { throw new FileNotFoundException(); };
        model.prepare(files, missing, STOP, "DEMUCS", value -> {});
        require(model.verifiedFile(cached) && networkCalls == 1);
        Files.delete(cached.toPath());
        networkBytes = BAD;
        rejects("DEMUCS_MODEL_INTEGRITY_FAILED", () -> model.prepare(files, null, STOP, "DEMUCS", value -> {}));
        require(!cached.exists() && !temporary.exists() && networkCalls == 2);
        networkBytes = new byte[4];
        rejects("DEMUCS_MODEL_SIZE_INVALID", () -> model.prepare(files, null, STOP, "DEMUCS", value -> {}));
        require(!cached.exists() && !temporary.exists());
    }
    private static void runtime(File root) throws Exception {
        Path base = root.toPath().resolve("demucs-runtime");
        Path previous = Files.createDirectories(base.resolve("a".repeat(64)));
        Files.createFile(previous.resolve(".complete"));
        Path abandoned = Files.createDirectories(base.resolve(".install-" + java.util.UUID.randomUUID()));
        Path incomplete = Files.createDirectories(base.resolve("b".repeat(64)));
        Files.writeString(incomplete.resolve("partial"), "unfinished");
        Path other = Files.createFile(base.resolve("unrelated"));
        var bytes = new ByteArrayOutputStream();
        try (var zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("worker/runner.py"));
            zip.write(GOOD);
            zip.closeEntry();
        }
        String hash = sha(bytes.toByteArray());
        var manifest = new JSONObject().put("runtimeSha256", hash).put("files", new JSONObject().put("worker/runner.py",
            new JSONObject().put("size", GOOD.length).put("sha256", sha(GOOD))));
        var install = DemucsRunner.class.getDeclaredMethod("install", File.class, JSONObject.class,
            AtomicBoolean.class, ModelAssetDescriptor.OpenAsset.class, ToLongFunction.class);
        install.setAccessible(true);
        var source = (ModelAssetDescriptor.OpenAsset) () -> new ByteArrayInputStream(bytes.toByteArray());
        var enough = (ToLongFunction<File>) file -> Long.MAX_VALUE;
        rejects("DEMUCS_STORAGE_INSUFFICIENT", () -> install.invoke(null, base.toFile(), manifest, STOP,
            (ModelAssetDescriptor.OpenAsset) () -> { throw new AssertionError("Read zip on low disk"); },
            (ToLongFunction<File>) file -> 0));
        require(Files.exists(previous) && !Files.exists(abandoned) && !Files.exists(incomplete) && Files.exists(other));
        rejects("DEMUCS_ASSET_INTEGRITY_FAILED", () -> install.invoke(null, base.toFile(), manifest, STOP,
            (ModelAssetDescriptor.OpenAsset) () -> new ByteArrayInputStream(BAD), enough));
        require(Files.exists(previous) && !Files.exists(base.resolve(hash)));
        File installed = (File) install.invoke(null, base.toFile(), manifest, STOP, source, enough);
        require(Files.exists(installed.toPath().resolve(".complete")) && !Files.exists(previous) && Files.exists(other));
        require(installed.equals(install.invoke(null, base.toFile(), manifest, STOP,
            (ModelAssetDescriptor.OpenAsset) () -> { throw new AssertionError("Read zip for verified runtime"); }, enough)));
        Files.write(installed.toPath().resolve("worker/runner.py"), BAD);
        install.invoke(null, base.toFile(), manifest, STOP, source, enough);
        require(java.util.Arrays.equals(Files.readAllBytes(installed.toPath().resolve("worker/runner.py")), GOOD));
    }
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]);
        model(root);
        runtime(root);
        System.out.println("PASS model and runtime cache lifecycle");
    }
}
`);
  const sources = ["InferenceLock.java", "ModelAssetDescriptor.java", "DemucsRunner.java"].map((name) => fileURLToPath(
    new URL(`../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/${name}`, import.meta.url)));
  const compiled = spawnSync(path.join(java, "bin/javac"), ["-d", temporary, ...stubs, ...sources, harness], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(path.join(java, "bin/java"), ["-cp", temporary, "com.tuneforge.desktop.DemucsCacheCheck", temporary],
    { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /PASS model and runtime cache lifecycle/);
});
