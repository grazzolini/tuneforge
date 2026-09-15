package com.tuneforge.desktop;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

final class CremaRunner {
    private static final String REVISION = "895b249c4ccabaedc0770b12935c2b7b2f60e145";
    private static final ModelAssetDescriptor MODEL = new ModelAssetDescriptor("crema", REVISION,
        "crema-0.2.0-opset18.onnx", "models/crema/crema-0.2.0-opset18.onnx",
        "https://huggingface.co/grazzolini/tuneforge-models/resolve/" + REVISION + "/crema/crema-0.2.0-opset18.onnx",
        2193804L, "a903f9709821fccebb31d4e93d7d783642faaa90859f45f308c0f9131cc7ca59");
    private static final ModelAssetDescriptor STATE = new ModelAssetDescriptor("crema", REVISION,
        "crema-0.2.0-runtime-state.json", "models/crema/crema-0.2.0-runtime-state.json",
        "https://huggingface.co/grazzolini/tuneforge-models/resolve/" + REVISION + "/crema/crema-0.2.0-runtime-state.json",
        3790L, "3744bf9ecb47de7194cb9f250fba26678ea347911af32ec4813645d5e033aca2");
    private static final ConcurrentHashMap<String, AtomicBoolean> CANCELLATIONS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> LAST_ERRORS = new ConcurrentHashMap<>();
    private static OrtEnvironment environment;
    private static OrtSession session;
    private static String sessionPath;

    private CremaRunner() {}

    static String status(Context context) {
        boolean model = file(context, MODEL).exists();
        boolean state = file(context, STATE).exists();
        if (!model && !state) return "download-required";
        try { return verify(file(context, MODEL), MODEL) && verify(file(context, STATE), STATE) ? "ready" : "corrupt"; }
        catch (Exception ignored) { return "corrupt"; }
    }

    static String prepare(Context context, String jobId) {
        AtomicBoolean cancellation = cancellation(jobId);
        LAST_ERRORS.remove(jobId);
        try {
            preparePair(context, cancellation);
            return readState(file(context, STATE));
        } catch (RuntimeException error) {
            LAST_ERRORS.put(jobId, error.getMessage() == null ? "CREMA_RUNTIME_FAILED" : error.getMessage());
            throw error;
        } finally { CANCELLATIONS.remove(jobId, cancellation); }
    }

    static float[][] run(Context context, float[] input, int frames, String jobId) {
        if (frames <= 0 || input.length != frames * 216 * 2) throw new IllegalArgumentException("CREMA_INPUT_SHAPE_INVALID");
        AtomicBoolean cancellation = cancellation(jobId);
        LAST_ERRORS.remove(jobId);
        try {
            synchronized (InferenceLock.LOCK) {
                if (cancellation.get()) throw new IllegalStateException("CREMA_CANCELLED");
                File model = file(context, MODEL);
                if (!verify(model, MODEL) || !verify(file(context, STATE), STATE)) throw new IllegalStateException("CREMA_MODEL_INTEGRITY_FAILED");
                if (environment == null) environment = OrtEnvironment.getEnvironment();
                if (session == null || !model.getAbsolutePath().equals(sessionPath)) {
                    if (session != null) session.close();
                    OrtSession.SessionOptions options = new OrtSession.SessionOptions();
                    options.setIntraOpNumThreads(Math.max(1, Runtime.getRuntime().availableProcessors() / 2));
                    session = environment.createSession(model.getAbsolutePath(), options);
                    Set<String> expectedOutputs = new LinkedHashSet<>(Arrays.asList(
                        "Identity:0", "Identity_1:0", "Identity_2:0", "Identity_3:0"));
                    if (!session.getInputNames().equals(Collections.singleton("cqt_mag"))
                        || !session.getOutputNames().equals(expectedOutputs)) {
                        session.close(); session = null; sessionPath = null;
                        throw new IllegalStateException("CREMA_OUTPUT_SHAPE_INVALID");
                    }
                    sessionPath = model.getAbsolutePath();
                }
                String[] outputNames = {"Identity:0", "Identity_1:0", "Identity_2:0", "Identity_3:0"};
                try (OnnxTensor tensor = OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), new long[] {1, frames, 216, 2});
                     OrtSession.Result result = session.run(Collections.singletonMap("cqt_mag", tensor),
                         new LinkedHashSet<>(Arrays.asList(outputNames)))) {
                    if (cancellation.get()) throw new IllegalStateException("CREMA_CANCELLED");
                    int[] widths = {170, 12, 13, 13};
                    float[][] flattened = new float[4][];
                    for (int index = 0; index < 4; index++) {
                        Object value = result.get(outputNames[index])
                            .orElseThrow(() -> new IllegalStateException("CREMA_OUTPUT_SHAPE_INVALID"))
                            .getValue();
                        if (!(value instanceof float[][][])) throw new IllegalStateException("CREMA_OUTPUT_SHAPE_INVALID");
                        float[][][] batch = (float[][][]) value;
                        if (batch.length != 1 || batch[0].length != frames) throw new IllegalStateException("CREMA_OUTPUT_SHAPE_INVALID");
                        flattened[index] = new float[frames * widths[index]];
                        for (int frame = 0; frame < frames; frame++) {
                            if (batch[0][frame].length != widths[index]) throw new IllegalStateException("CREMA_OUTPUT_SHAPE_INVALID");
                            System.arraycopy(batch[0][frame], 0, flattened[index], frame * widths[index], widths[index]);
                        }
                    }
                    return flattened;
                }
            }
        } catch (Exception error) {
            String code = error.getMessage(); LAST_ERRORS.put(jobId, code == null ? "CREMA_RUNTIME_FAILED" : code);
            if (error instanceof RuntimeException) throw (RuntimeException) error;
            throw new IllegalStateException("CREMA_RUNTIME_FAILED", error);
        } finally { CANCELLATIONS.remove(jobId, cancellation); }
    }

    static void cancel(String jobId) { if (jobId != null && !jobId.isEmpty()) cancellation(jobId).set(true); }
    static String takeError(String jobId) { String code = LAST_ERRORS.remove(jobId); return code == null ? "CREMA_RUNTIME_FAILED" : code; }

    private static AtomicBoolean cancellation(String jobId) {
        if (jobId == null || jobId.isEmpty()) throw new IllegalArgumentException("CREMA_JOB_ID_INVALID");
        return CANCELLATIONS.computeIfAbsent(jobId, ignored -> new AtomicBoolean(false));
    }

    private static void preparePair(Context context, AtomicBoolean cancellation) {
        try {
            File model = file(context, MODEL); File state = file(context, STATE);
            if (verify(model, MODEL) && verify(state, STATE)) return;
            File targetRoot = model.getParentFile();
            File familyRoot = targetRoot == null ? null : targetRoot.getParentFile();
            if (familyRoot == null || (!familyRoot.isDirectory() && !familyRoot.mkdirs())) throw new IllegalStateException("CREMA_MODEL_STORAGE_UNAVAILABLE");
            if (familyRoot.getUsableSpace() < (MODEL.size + STATE.size) * 2) throw new IllegalStateException("CREMA_MODEL_STORAGE_INSUFFICIENT");
            String identity = UUID.randomUUID().toString();
            File stagingRoot = new File(familyRoot, "." + REVISION + "." + identity + ".staging");
            File backupRoot = new File(familyRoot, "." + REVISION + "." + identity + ".backup");
            if (!stagingRoot.mkdir()) throw new IllegalStateException("CREMA_MODEL_STAGING_UNAVAILABLE");
            File modelTemp = new File(stagingRoot, MODEL.fileName);
            File stateTemp = new File(stagingRoot, STATE.fileName);
            try {
                acquire(context, MODEL, modelTemp, cancellation); acquire(context, STATE, stateTemp, cancellation);
                if (!verify(modelTemp, MODEL) || !verify(stateTemp, STATE)) throw new IllegalStateException("CREMA_MODEL_INTEGRITY_FAILED");
                synchronized (InferenceLock.LOCK) {
                    boolean backedUp = false;
                    if (targetRoot.exists()) {
                        if (!targetRoot.renameTo(backupRoot)) throw new IllegalStateException("CREMA_MODEL_REPLACE_FAILED");
                        backedUp = true;
                    }
                    if (!stagingRoot.renameTo(targetRoot)) {
                        if (backedUp) backupRoot.renameTo(targetRoot);
                        throw new IllegalStateException("CREMA_MODEL_REPLACE_FAILED");
                    }
                    if (!verify(model, MODEL) || !verify(state, STATE)) {
                        deleteRecursively(targetRoot);
                        if (backedUp) backupRoot.renameTo(targetRoot);
                        throw new IllegalStateException("CREMA_MODEL_INTEGRITY_FAILED");
                    }
                    deleteRecursively(backupRoot);
                }
            } finally { deleteRecursively(stagingRoot); }
        } catch (IllegalStateException error) { throw error; }
        catch (Exception error) { throw new IllegalStateException("CREMA_MODEL_DOWNLOAD_FAILED", error); }
    }
    private static void acquire(Context context, ModelAssetDescriptor asset, File destination, AtomicBoolean cancellation) throws Exception {
        try (InputStream input = context.getAssets().open(asset.bundlePath)) { copy(input, destination, asset.size, cancellation); return; }
        catch (java.io.FileNotFoundException ignored) {}
        HttpURLConnection connection = (HttpURLConnection) new URL(asset.url).openConnection();
        connection.setConnectTimeout(30000); connection.setReadTimeout(60000); connection.setRequestProperty("User-Agent", "TuneForge/1");
        try { int response = connection.getResponseCode(); if (response < 200 || response >= 300) throw new IllegalStateException("CREMA_MODEL_DOWNLOAD_HTTP_" + response);
            try (InputStream input = connection.getInputStream()) { copy(input, destination, asset.size, cancellation); } }
        finally { connection.disconnect(); }
    }
    private static void copy(InputStream input, File destination, long expected, AtomicBoolean cancellation) throws Exception {
        byte[] buffer = new byte[1024 * 1024]; long total = 0;
        try (FileOutputStream output = new FileOutputStream(destination)) { int count; while ((count = input.read(buffer)) != -1) {
            if (cancellation.get()) throw new IllegalStateException("CREMA_CANCELLED"); total += count;
            if (total > expected) throw new IllegalStateException("CREMA_MODEL_SIZE_INVALID"); output.write(buffer, 0, count); }
            output.getFD().sync(); }
        if (total != expected) throw new IllegalStateException("CREMA_MODEL_SIZE_INVALID");
    }
    private static String readState(File file) {
        try (InputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream((int) STATE.size)) {
            byte[] buffer = new byte[4096]; int count; long total = 0;
            while ((count = input.read(buffer)) != -1) {
                total += count; if (total > STATE.size) throw new IllegalStateException("CREMA_RUNTIME_STATE_INVALID");
                output.write(buffer, 0, count);
            }
            if (total != STATE.size) throw new IllegalStateException("CREMA_RUNTIME_STATE_INVALID");
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (java.io.IOException error) { throw new IllegalStateException("CREMA_RUNTIME_STATE_INVALID", error); }
    }
    private static void deleteRecursively(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }
    private static boolean verify(File file, ModelAssetDescriptor asset) throws Exception {
        if (!file.isFile() || file.length() != asset.size) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[1024 * 1024];
        try (InputStream input = new FileInputStream(file)) { int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); }
        StringBuilder actual = new StringBuilder(64); for (byte value : digest.digest()) actual.append(String.format("%02x", value & 0xff));
        return asset.sha256.equals(actual.toString());
    }
    private static File file(Context context, ModelAssetDescriptor asset) {
        return new File(new File(new File(new File(context.getFilesDir(), "models"), asset.family), asset.revision), asset.fileName);
    }
}
