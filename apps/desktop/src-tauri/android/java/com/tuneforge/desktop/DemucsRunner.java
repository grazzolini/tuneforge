package com.tuneforge.desktop;

import android.content.Context;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Comparator;
import java.util.function.ToLongFunction;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

/** App-private Android CPU stem runtime with a separately acquired checkpoint. */
final class DemucsRunner {
    private static final String ASSET = "demucs-runtime/";
    private static final ConcurrentHashMap<String, AtomicBoolean> CANCELLED = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, Process> PROCESSES = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, Integer> PROGRESS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> ERRORS = new ConcurrentHashMap<>();

    private static final int MODEL_PROGRESS_END = 15;
    private static final long MAX_RUNTIME_BYTES = 1536L * 1024 * 1024;
    private static final String EXECUTABLE = "libtuneforge_demucs_python.so";
    private static final String HASH = "[a-f0-9]{64}";
    private static final ModelAssetDescriptor.VerificationCache EXECUTABLE_VERIFICATION =
        new ModelAssetDescriptor.VerificationCache();
    private static JSONObject packagedRuntime;
    private static ModelAssetDescriptor packagedModel;
    private static boolean bundledModel;

    private DemucsRunner() {}

    static String status(Context context) {
        try {
            JSONObject runtime = descriptor(context);
            File executable = executable(context);
            if (!executable.isFile()) return "unavailable";
            if (!verifyExecutable(executable, runtime)) return "corrupt";
            ModelAssetDescriptor model = modelDescriptor(context, runtime);
            return model.verifiedFile(model.cachedFile(context.getFilesDir()))
                || (bundledModel && model.verifiedBundle(() -> context.getAssets().open(model.bundlePath)))
                ? "ready" : "download-required";
        } catch (java.io.FileNotFoundException missing) {
            return "unavailable";
        } catch (Exception error) {
            return "corrupt";
        }
    }

    static int progress(String jobId) { return PROGRESS.getOrDefault(jobId, 0); }

    static String takeError(String jobId) {
        String error = ERRORS.remove(jobId);
        return error == null ? "DEMUCS_RUNTIME_FAILED" : error;
    }

    static void cancel(String jobId) {
        if (jobId == null || jobId.isEmpty()) return;
        AtomicBoolean cancellation = CANCELLED.get(jobId);
        if (cancellation != null) cancellation.set(true);
        Process process = PROCESSES.get(jobId);
        if (process != null) process.destroyForcibly();
    }

    static String run(Context context, String inputPath, String outputPath, String jobId) {
        if (jobId == null || !jobId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("DEMUCS_JOB_ID_INVALID");
        }
        AtomicBoolean cancellation = CANCELLED.computeIfAbsent(jobId, ignored -> new AtomicBoolean());
        Process process = null;
        ERRORS.remove(jobId);
        PROGRESS.put(jobId, 0);
        try {
            synchronized (InferenceLock.LOCK) {
                try {
                    checkCancelled(cancellation);
                    File[] paths = validateJobPaths(context.getDataDir(), inputPath, outputPath, jobId);
                    File input = paths[0];
                    File output = paths[1];
                    if (!input.isFile() || !output.isDirectory() || output.list() == null || output.list().length != 0) {
                        throw new IllegalStateException("DEMUCS_PATHS_INVALID");
                    }
                    JSONObject manifest = descriptor(context);
                    File executable = executable(context);
                    if (!verifyExecutable(executable, manifest)) {
                        throw new IllegalStateException("DEMUCS_EXECUTABLE_INTEGRITY_FAILED");
                    }
                    ModelAssetDescriptor model = modelDescriptor(context, manifest);
                    File modelFile;
                    try {
                        modelFile = model.prepare(context.getFilesDir(),
                            bundledModel ? () -> context.getAssets().open(model.bundlePath) : null,
                            cancellation, "DEMUCS",
                            progress -> PROGRESS.merge(jobId, progress * MODEL_PROGRESS_END / 100, Math::max));
                    } catch (IllegalStateException error) {
                        throw error;
                    } catch (Exception error) {
                        throw new IllegalStateException("DEMUCS_MODEL_DOWNLOAD_FAILED", error);
                    }
                    PROGRESS.merge(jobId, MODEL_PROGRESS_END, Math::max);
                    File runtime = install(new File(context.getFilesDir(), "demucs-runtime"), manifest, cancellation,
                        () -> context.getAssets().open(ASSET + "runtime.zip"), File::getUsableSpace);
                    checkCancelled(cancellation);
                    ProcessBuilder builder = new ProcessBuilder(executable.getCanonicalPath(), "-s", "-B",
                        new File(runtime, "worker/runner.py").getCanonicalPath(), input.getPath(), output.getPath(),
                        modelFile.getCanonicalPath());
                    builder.directory(runtime);
                    builder.redirectErrorStream(true);
                    Map<String, String> env = builder.environment();
                    env.clear();
                    env.put("PATH", "/system/bin");
                    env.put("HOME", runtime.getCanonicalPath());
                    env.put("TMPDIR", context.getCacheDir().getCanonicalPath());
                    env.put("PYTHONHOME", runtime.getCanonicalPath());
                    env.put("PYTHONPATH", new File(runtime, "worker").getCanonicalPath() + ":"
                        + new File(runtime, "lib/python3.14").getCanonicalPath() + ":"
                        + new File(runtime, "lib/python3.14/lib-dynload").getCanonicalPath() + ":"
                        + new File(runtime, "lib/python3.14/site-packages").getCanonicalPath());
                    env.put("PYTHONNOUSERSITE", "1");
                    env.put("PYTHONDONTWRITEBYTECODE", "1");
                    env.put("LD_LIBRARY_PATH", new File(runtime, "lib").getCanonicalPath() + ":"
                        + new File(runtime, "lib/python3.14/site-packages/torch/lib").getCanonicalPath());
                    for (String name : new String[] {"OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                        "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "BLIS_NUM_THREADS", "GOTO_NUM_THREADS"}) {
                        env.put(name, "1");
                    }
                    env.put("OMP_DYNAMIC", "FALSE");
                    String blasSha256 = manifest.getString("openblasSha256");
                    env.put("TUNEFORGE_DEMUCS_OPENBLAS_SHA256", blasSha256);
                    process = builder.start();
                    PROCESSES.put(jobId, process);
                    checkCancelled(cancellation);
                    Process ownedProcess = process;
                    AtomicBoolean timedOut = new AtomicBoolean();
                    Thread watchdog = new Thread(() -> {
                        try {
                            if (!ownedProcess.waitFor(1200, TimeUnit.SECONDS)) {
                                timedOut.set(true);
                                ownedProcess.destroyForcibly();
                            }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        ownedProcess.destroyForcibly();
                    }
                }, "tuneforge-demucs-deadline");
                watchdog.setDaemon(true);
                watchdog.start();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    int diagnostics = 0;
                    while ((line = reader.readLine()) != null) {
                        checkCancelled(cancellation);
                        if (line.length() > 8192) throw new IllegalStateException("DEMUCS_WORKER_PROTOCOL_INVALID");
                        if (line.startsWith("{")) {
                            JSONObject event = new JSONObject(line);
                            int value = event.optInt("progress", 0);
                            int inference = MODEL_PROGRESS_END + Math.max(0, Math.min(100, value)) * (100 - MODEL_PROGRESS_END) / 100;
                            PROGRESS.merge(jobId, inference, Math::max);
                            String phase = event.optString("phase", "unknown");
                            if (phase.matches("[a-z_]{1,40}")) {
                                Log.i("TuneForgeDemucs", "phase=" + phase + " progress=" + value);
                                if ("runtime_config".equals(phase) || "complete".equals(phase)) {
                                    logRuntimeEvidence(event, phase, blasSha256);
                                }
                            }
                            String code = event.optString("code", "");
                            if (code.matches("DEMUCS_[A-Z_]{1,80}")) ERRORS.put(jobId, code);
                        } else if (++diagnostics <= 8) {
                            // Upstream startup diagnostics contain no input data;
                            // retain only a bounded log for local runtime diagnosis.
                            Log.w("TuneForgeDemucs", line);
                        }
                    }
                }
                int exit = process.waitFor();
                checkCancelled(cancellation);
                if (timedOut.get()) throw new IllegalStateException("DEMUCS_TIMEOUT");
                if (exit != 0) throw new IllegalStateException(ERRORS.getOrDefault(jobId, "DEMUCS_WORKER_FAILED"));
                File result = new File(output, "result.json");
                if (!result.isFile() || result.length() > 16384) throw new IllegalStateException("DEMUCS_MANIFEST_INVALID");
                return new String(Files.readAllBytes(result.toPath()), StandardCharsets.UTF_8);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                } finally {
                    // Reap the owned worker before releasing the inference lock.
                    if (process != null) {
                        stopAndWait(process);
                        PROCESSES.remove(jobId, process);
                    }
                }
            }
        } catch (Exception error) {
            String code = cancellation.get() ? "DEMUCS_CANCELLED" : error.getMessage();
            if (code != null && code.startsWith("DEMUCS_MODEL_DOWNLOAD_HTTP_")) code = "DEMUCS_MODEL_DOWNLOAD_FAILED";
            if (code == null || !code.matches("DEMUCS_[A-Z_]{1,80}")) code = "DEMUCS_RUNTIME_FAILED";
            ERRORS.put(jobId, code);
            throw new IllegalStateException(code, error);
        } finally {
            CANCELLED.remove(jobId, cancellation);
            PROGRESS.remove(jobId);
        }
    }

    private static void logRuntimeEvidence(JSONObject event, String phase, String blasSha256) throws Exception {
        String config = event.getString("openblas_config");
        if (event.getInt("threads") != 4 || event.getInt("interop_threads") != 1
            || event.getInt("blas_threads") != 1 || event.getInt("blas_parallel") != 1
            || !"pthread".equals(event.getString("blas_implementation"))
            || !blasSha256.equals(event.getString("openblas_sha256"))
            || !config.matches("[A-Za-z0-9 ._+=-]{1,256}")) {
            throw new IllegalStateException("DEMUCS_THREAD_CONFIGURATION_INVALID");
        }
        JSONObject safe = new JSONObject().put("event", "complete".equals(phase) ? "runtime_complete" : "runtime_config")
            .put("threads", event.getInt("threads")).put("interop_threads", event.getInt("interop_threads"))
            .put("blas_threads", event.getInt("blas_threads")).put("blas_parallel", event.getInt("blas_parallel"))
            .put("blas_implementation", "pthread").put("openblas_sha256", blasSha256).put("openblas_config", config);
        if ("complete".equals(phase)) {
            double inference = event.getDouble("inference_s");
            double elapsed = event.getDouble("elapsed_s");
            if (!Double.isFinite(inference) || !Double.isFinite(elapsed) || inference <= 0 || elapsed < inference) {
                throw new IllegalStateException("DEMUCS_WORKER_PROTOCOL_INVALID");
            }
            safe.put("inference_s", inference).put("elapsed_s", elapsed);
        }
        // Only validated numeric/configuration fields; no paths or user material.
        Log.i("TuneForgeDemucs", safe.toString());
    }

    private static void stopAndWait(Process process) {
        boolean interrupted = Thread.interrupted();
        process.destroyForcibly();
        try {
            while (true) {
                try {
                    process.waitFor();
                    return;
                } catch (InterruptedException retry) {
                    interrupted = true;
                    process.destroyForcibly();
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static File[] validateJobPaths(File appDataDirectory, String inputPath, String outputPath, String jobId) throws Exception {
        File root = appDataDirectory.getCanonicalFile();
        File input = new File(inputPath).getCanonicalFile();
        File output = new File(outputPath).getCanonicalFile();
        File job = input.getParentFile();
        File stems = job == null ? null : job.getParentFile();
        File project = stems == null ? null : stems.getParentFile();
        File projects = project == null ? null : project.getParentFile();
        if (jobId == null || !jobId.matches("[A-Za-z0-9_-]{1,128}") || job == null || stems == null || project == null
            || !"input.wav".equals(input.getName()) || !"native".equals(output.getName())
            || !job.equals(output.getParentFile()) || !("." + jobId).equals(job.getName())
            || !"stems".equals(stems.getName()) || !project.getName().matches("[A-Za-z0-9_-]{1,128}")
            || !new File(root, "projects").equals(projects)) {
            throw new IllegalStateException("DEMUCS_PATH_OUTSIDE_APP");
        }
        return new File[] {input, output};
    }

    private static File executable(Context context) {
        return new File(context.getApplicationInfo().nativeLibraryDir, EXECUTABLE);
    }

    private static boolean verifyExecutable(File executable, JSONObject manifest) throws Exception {
        return EXECUTABLE_VERIFICATION.verify(executable,
            () -> hash(executable, new AtomicBoolean()).equals(manifest.getString("executableSha256")));
    }

    private static JSONObject readDescriptor(Context context, String name, int limit) throws Exception {
        try (InputStream input = context.getAssets().open(name)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > limit) throw new IllegalStateException("DEMUCS_ASSET_MANIFEST_INVALID");
                bytes.write(buffer, 0, count);
            }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    private static synchronized JSONObject descriptor(Context context) throws Exception {
        if (packagedRuntime == null) {
            JSONObject manifest = readDescriptor(context, ASSET + "manifest.json", 4 * 1024 * 1024);
            if (manifest.getInt("version") != 2 || !"android-cpu".equals(manifest.getString("profile"))
                || !"arm64-v8a".equals(manifest.getString("abi")) || !"3.14".equals(manifest.getString("python"))
                || manifest.getInt("threads") != 4 || manifest.getInt("interopThreads") != 1
                || manifest.getInt("blasThreads") != 1 || manifest.getInt("blasParallel") != 1
                || !"cpu-t4-b1-openblas-pthread".equals(manifest.getString("variant"))) {
                throw new IllegalStateException("DEMUCS_ASSET_MANIFEST_INVALID");
            }
            for (String field : new String[] {"openblasSha256", "runtimeSha256", "executableSha256", "modelSha256"}) {
                if (!manifest.getString(field).matches(HASH)) {
                    throw new IllegalStateException("DEMUCS_ASSET_MANIFEST_INVALID");
                }
            }
            packagedRuntime = manifest;
        }
        return packagedRuntime;
    }

    private static synchronized ModelAssetDescriptor modelDescriptor(Context context, JSONObject runtime) throws Exception {
        if (packagedModel == null) {
            JSONObject manifest = readDescriptor(context, "models/manifest.json", 32 * 1024);
            org.json.JSONArray assets = manifest.getJSONArray("assets");
            for (int index = 0; index < assets.length(); index++) {
                JSONObject asset = assets.getJSONObject(index);
                if (!"demucs".equals(asset.getString("family"))) continue;
                String revision = asset.getString("revision");
                String file = asset.getString("fileName");
                String url = asset.getString("url");
                long size = asset.getLong("size");
                String sha = asset.getString("sha256");
                String bundle = "models/demucs/" + file;
                if (!revision.matches("[a-f0-9]{40}") || !file.matches("[a-f0-9]{8}\\.safetensors")
                    || !url.equals("https://huggingface.co/adefossez/HTDemucs-6s/resolve/" + revision + "/" + file)
                    || !bundle.equals(asset.getString("relativePath")) || size <= 0 || size > 64L * 1024 * 1024
                    || !sha.equals(runtime.getString("modelSha256"))) {
                    throw new IllegalStateException("DEMUCS_MODEL_DESCRIPTOR_INVALID");
                }
                bundledModel = asset.getBoolean("bundled");
                packagedModel = new ModelAssetDescriptor("demucs", revision, file, bundle, url, size, sha);
                return packagedModel;
            }
            throw new IllegalStateException("DEMUCS_MODEL_DESCRIPTOR_INVALID");
        }
        return packagedModel;
    }

    // InferenceLock covers both installation and use of this reconstructible runtime.
    private static File install(File base, JSONObject manifest, AtomicBoolean cancellation,
                                ModelAssetDescriptor.OpenAsset source, ToLongFunction<File> usableSpace) throws Exception {
        String expected = manifest.getString("runtimeSha256");
        if (!expected.matches(HASH)) throw new IllegalStateException("DEMUCS_ASSET_MANIFEST_INVALID");
        if (Files.isSymbolicLink(base.toPath())) throw new IllegalStateException("DEMUCS_ARCHIVE_INVALID");
        if (!base.isDirectory() && !base.mkdirs()) throw new IllegalStateException("DEMUCS_STORAGE_UNAVAILABLE");
        File destination = new File(base, expected);
        if (complete(destination) && verifyInstalled(destination, manifest.getJSONObject("files"), cancellation)) {
            cleanRuntime(base, destination, false, cancellation);
            return destination;
        }
        deleteStaging(destination);
        cleanRuntime(base, destination, true, cancellation);
        JSONObject entries = manifest.getJSONObject("files");
        long needed = 0;
        for (java.util.Iterator<String> names = entries.keys(); names.hasNext();) {
            long size = entries.getJSONObject(names.next()).getLong("size");
            if (size < 0 || size > MAX_RUNTIME_BYTES - needed) throw new IllegalStateException("DEMUCS_ARCHIVE_TOO_LARGE");
            needed += size;
        }
        if (usableSpace.applyAsLong(base) < needed + 8L * 1024 * 1024) {
            throw new IllegalStateException("DEMUCS_STORAGE_INSUFFICIENT");
        }
        File staging = new File(base, ".install-" + java.util.UUID.randomUUID());
        if (!staging.mkdir()) throw new IllegalStateException("DEMUCS_STORAGE_UNAVAILABLE");
        try {
            Set<String> found = new HashSet<>();
            long unpacked = 0;
            MessageDigest archiveDigest = MessageDigest.getInstance("SHA-256");
            try (InputStream stream = source.open();
                 java.security.DigestInputStream hashed = new java.security.DigestInputStream(stream, archiveDigest);
                 ZipInputStream archive = new ZipInputStream(hashed)) {
                ZipEntry entry;
                byte[] buffer = new byte[1024 * 1024];
                while ((entry = archive.getNextEntry()) != null) {
                    checkCancelled(cancellation);
                    String name = entry.getName();
                    if (entry.isDirectory() || !entries.has(name) || !found.add(name)) throw new IllegalStateException("DEMUCS_ARCHIVE_INVALID");
                    File target = new File(staging, name).getCanonicalFile();
                    if (!target.getPath().startsWith(staging.getCanonicalPath() + File.separator)) throw new IllegalStateException("DEMUCS_ARCHIVE_INVALID");
                    File parent = target.getParentFile();
                    if (!parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException("DEMUCS_STORAGE_UNAVAILABLE");
                    long size = 0;
                    long expectedSize = entries.getJSONObject(name).getLong("size");
                    try (FileOutputStream output = new FileOutputStream(target)) {
                        int count;
                        while ((count = archive.read(buffer)) != -1) {
                            checkCancelled(cancellation);
                            size += count;
                            unpacked += count;
                            if (size > expectedSize || unpacked > MAX_RUNTIME_BYTES) throw new IllegalStateException("DEMUCS_ARCHIVE_TOO_LARGE");
                            output.write(buffer, 0, count);
                        }
                    }
                    if (size != expectedSize || !hash(target, cancellation).equals(entries.getJSONObject(name).getString("sha256"))) throw new IllegalStateException("DEMUCS_ASSET_INTEGRITY_FAILED");
                }
                // ZipInputStream stops before the central directory. Hash all
                // remaining bytes so the descriptor covers the complete archive.
                while (hashed.read(buffer) != -1) { checkCancelled(cancellation); }
            }
            if (found.size() != entries.length() || !ModelAssetDescriptor.hex(archiveDigest.digest()).equals(expected)) throw new IllegalStateException("DEMUCS_ASSET_INTEGRITY_FAILED");
            checkCancelled(cancellation);
            if (!new File(staging, ".complete").createNewFile()) throw new IllegalStateException("DEMUCS_INSTALL_FAILED");
            Files.move(staging.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
            cleanRuntime(base, destination, false, cancellation);
            return destination;
        } finally {
            deleteStaging(staging);
        }
    }

    private static boolean verifyInstalled(File directory, JSONObject entries, AtomicBoolean cancellation) throws Exception {
        String root = directory.getCanonicalPath() + File.separator;
        java.util.Iterator<String> names = entries.keys();
        while (names.hasNext()) {
            checkCancelled(cancellation);
            String name = names.next();
            File file = new File(directory, name);
            if (Files.isSymbolicLink(file.toPath()) || !file.getCanonicalPath().startsWith(root)) return false;
            JSONObject spec = entries.getJSONObject(name);
            if (!file.isFile() || file.length() != spec.getLong("size") || !hash(file, cancellation).equals(spec.getString("sha256"))) return false;
        }
        return true;
    }

    private static boolean complete(File directory) {
        return directory.isDirectory() && !Files.isSymbolicLink(directory.toPath())
            && new File(directory, ".complete").isFile();
    }

    private static void cleanRuntime(File base, File destination, boolean keepPrevious,
                                     AtomicBoolean cancellation) throws Exception {
        File[] entries = base.listFiles();
        if (entries == null) throw new IllegalStateException("DEMUCS_STORAGE_UNAVAILABLE");
        Arrays.sort(entries, Comparator.comparingLong(File::lastModified).reversed().thenComparing(File::getName));
        for (File entry : entries) {
            checkCancelled(cancellation);
            if (entry.equals(destination)) continue;
            String name = entry.getName();
            if (name.matches("\\.install-[a-f0-9-]{36}")) {
                deleteStaging(entry);
            } else if (name.matches(HASH)) {
                if (keepPrevious && complete(entry)) keepPrevious = false;
                else deleteStaging(entry);
            }
        }
    }

    private static void deleteStaging(File file) throws Exception {
        if (!Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteStaging(child);
        }
        Files.deleteIfExists(file.toPath());
    }

    private static void checkCancelled(AtomicBoolean cancellation) {
        if (cancellation.get()) throw new IllegalStateException("DEMUCS_CANCELLED");
    }

    private static String hash(File file, AtomicBoolean cancellation) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                checkCancelled(cancellation);
                digest.update(buffer, 0, count);
            }
        }
        return ModelAssetDescriptor.hex(digest.digest());
    }
}
