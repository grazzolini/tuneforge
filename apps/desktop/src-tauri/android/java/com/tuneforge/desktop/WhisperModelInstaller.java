package com.tuneforge.desktop;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLException;

final class WhisperModelInstaller {
    private static final ModelAssetDescriptor ASSET = new ModelAssetDescriptor(
        "whisper", "98aa99a0a9db05ae2342309f5096248665f7cba3", "ggml-large-v3-turbo.bin",
        "models/whisper/ggml-large-v3-turbo.bin",
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/98aa99a0a9db05ae2342309f5096248665f7cba3/ggml-large-v3-turbo.bin",
        1624555275L, "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69");
    private static final ConcurrentHashMap<String, AtomicBoolean> CANCELLATIONS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> LAST_ERRORS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, Integer> PROGRESS = new ConcurrentHashMap<>();
    private static final Object INSTALL_LOCK = new Object();
    private static final Object INSTALL_STATE_LOCK = new Object();
    private static boolean installInProgress = false;
    private static volatile long verifiedLength = -1;
    private static volatile long verifiedLastModified = -1;
    private static final long INSTALL_OVERHEAD_BYTES = 64L * 1024L * 1024L;

    private WhisperModelInstaller() {}

    static String status(Context context) {
        File model = modelFile(context);
        try {
            File targetRoot = model.getParentFile();
            File familyRoot = targetRoot == null ? null : targetRoot.getParentFile();
            synchronized (INSTALL_STATE_LOCK) {
                if (!installInProgress && familyRoot != null && familyRoot.isDirectory()) {
                    recoverInterruptedInstall(familyRoot, targetRoot, model);
                }
            }
            if (!model.exists()) return "download-required";
            return verifyCached(model) ? "ready" : "corrupt";
        } catch (Exception ignored) { return "unavailable"; }
    }

    static String prepare(Context context, String jobId) {
        if (jobId == null || jobId.isEmpty()) throw new IllegalArgumentException("WHISPER_JOB_ID_INVALID");
        AtomicBoolean cancellation = CANCELLATIONS.computeIfAbsent(jobId, ignored -> new AtomicBoolean(false));
        LAST_ERRORS.remove(jobId);
        PROGRESS.put(jobId, 0);
        try {
            synchronized (INSTALL_LOCK) {
                synchronized (INSTALL_STATE_LOCK) { installInProgress = true; }
                try {
                    if (cancellation.get()) throw new IllegalStateException("WHISPER_CANCELLED");
                    String model = prepareLocked(context, cancellation, jobId);
                    PROGRESS.put(jobId, 200);
                    return model;
                } finally {
                    synchronized (INSTALL_STATE_LOCK) { installInProgress = false; }
                }
            }
        } catch (Exception error) {
            String code = error.getMessage();
            LAST_ERRORS.put(jobId,
                code != null && code.startsWith("WHISPER_")
                    ? code
                    : "WHISPER_MODEL_SETUP_FAILED");
            return "";
        } finally { CANCELLATIONS.remove(jobId, cancellation); }
    }

    static int progress(String jobId) {
        return PROGRESS.getOrDefault(jobId, -1);
    }

    static void clearProgress(String jobId) {
        PROGRESS.remove(jobId);
    }

    private static String prepareLocked(Context context, AtomicBoolean cancellation, String jobId)
            throws Exception {
            File destination = modelFile(context);
            File targetRoot = destination.getParentFile();
            File familyRoot = targetRoot == null ? null : targetRoot.getParentFile();
            if (familyRoot == null || (!familyRoot.isDirectory() && !familyRoot.mkdirs())) {
                throw new IllegalStateException("WHISPER_MODEL_STORAGE_UNAVAILABLE");
            }
            if (verifyCached(destination)) return destination.getAbsolutePath();
            recoverInterruptedInstall(familyRoot, targetRoot, destination);
            if (verifyCached(destination)) return destination.getAbsolutePath();
            long requiredSpace = ASSET.size + INSTALL_OVERHEAD_BYTES;
            long usableSpace = familyRoot.getUsableSpace();
            if (usableSpace < requiredSpace) {
                throw new IllegalStateException(
                    "WHISPER_MODEL_STORAGE_INSUFFICIENT:" + (requiredSpace - usableSpace));
            }
            String identity = UUID.randomUUID().toString();
            File stagingRoot = new File(familyRoot, "." + ASSET.revision + "." + identity + ".staging");
            File backupRoot = new File(familyRoot, "." + ASSET.revision + "." + identity + ".backup");
            if (!stagingRoot.mkdir()) throw new IllegalStateException("WHISPER_MODEL_STAGING_UNAVAILABLE");
            File temporary = new File(stagingRoot, ASSET.fileName);
            try {
                acquire(context, temporary, cancellation, jobId);
                if (!verifyForInstall(temporary, cancellation, jobId, 100, 50)) {
                    throw new IllegalStateException("WHISPER_MODEL_INTEGRITY_FAILED");
                }
                if (cancellation.get()) throw new IllegalStateException("WHISPER_CANCELLED");
                synchronized (InferenceLock.LOCK) {
                    boolean backedUp = false;
                    if (targetRoot.exists()) {
                        if (!targetRoot.renameTo(backupRoot)) throw new IllegalStateException("WHISPER_MODEL_REPLACE_FAILED");
                        backedUp = true;
                    }
                    if (!stagingRoot.renameTo(targetRoot)) {
                        if (backedUp) backupRoot.renameTo(targetRoot);
                        throw new IllegalStateException("WHISPER_MODEL_REPLACE_FAILED");
                    }
                    PROGRESS.put(jobId, 150);
                    if (!verify(destination)) {
                        deleteRecursively(targetRoot);
                        if (backedUp) backupRoot.renameTo(targetRoot);
                        throw new IllegalStateException("WHISPER_MODEL_INTEGRITY_FAILED");
                    }
                    PROGRESS.put(jobId, 199);
                    rememberVerified(destination);
                    deleteRecursively(backupRoot);
                }
            } finally { deleteRecursively(stagingRoot); }
            return destination.getAbsolutePath();
    }

    private static void recoverInterruptedInstall(File familyRoot, File targetRoot, File destination)
            throws Exception {
        File[] entries = familyRoot.listFiles();
        if (entries == null) return;
        File verifiedBackup = null;
        for (File entry : entries) {
            String name = entry.getName();
            if (name.startsWith("." + ASSET.revision) && name.endsWith(".staging")) {
                deleteRecursively(entry);
            } else if (name.startsWith("." + ASSET.revision) && name.endsWith(".backup")) {
                File candidate = new File(entry, ASSET.fileName);
                if (verifiedBackup == null && verify(candidate)) verifiedBackup = entry;
                else deleteRecursively(entry);
            }
        }
        if (verifiedBackup != null && !verify(destination)) {
            deleteRecursively(targetRoot);
            if (!verifiedBackup.renameTo(targetRoot)) {
                throw new IllegalStateException("WHISPER_MODEL_RECOVERY_FAILED");
            }
            rememberVerified(destination);
        } else if (verifiedBackup != null) {
            deleteRecursively(verifiedBackup);
        }
    }

    static void cancel(String jobId) {
        if (jobId != null && !jobId.isEmpty()) {
            CANCELLATIONS.computeIfAbsent(jobId, ignored -> new AtomicBoolean(false)).set(true);
        }
    }

    static String takeError(String jobId) {
        String code = LAST_ERRORS.remove(jobId);
        return code == null ? "WHISPER_MODEL_DOWNLOAD_FAILED" : code;
    }

    private static void acquire(
            Context context, File destination, AtomicBoolean cancellation, String jobId)
            throws Exception {
        try (InputStream input = context.getAssets().open(ASSET.bundlePath)) {
            copy(input, destination, cancellation, jobId);
            return;
        } catch (java.io.FileNotFoundException ignored) {}
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ASSET.url).openConnection();
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(60000);
            connection.setRequestProperty("User-Agent", "TuneForge/1");
            connection.setInstanceFollowRedirects(true);
            int response = connection.getResponseCode();
            if (response < 200 || response >= 300) {
                throw new IllegalStateException("WHISPER_MODEL_DOWNLOAD_HTTP_" + response);
            }
            try (InputStream input = connection.getInputStream()) {
                copy(input, destination, cancellation, jobId);
            }
        } catch (SourceReadException error) {
            throw downloadFailure(error.source);
        } catch (IOException error) {
            throw downloadFailure(error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void copy(
            InputStream input, File destination, AtomicBoolean cancellation, String jobId)
            throws Exception {
        byte[] buffer = new byte[1024 * 1024];
        long total = 0;
        try (FileOutputStream output = new FileOutputStream(destination, false)) {
            while (true) {
                int count;
                try {
                    count = input.read(buffer);
                } catch (IOException error) {
                    throw new SourceReadException(error);
                }
                if (count == -1) break;
                if (cancellation.get()) throw new IllegalStateException("WHISPER_CANCELLED");
                total += count;
                if (total > ASSET.size) throw new IllegalStateException("WHISPER_MODEL_SIZE_INVALID");
                output.write(buffer, 0, count);
                PROGRESS.put(jobId, (int) Math.min(99L, total * 100L / ASSET.size));
            }
            output.getFD().sync();
        } catch (IOException error) {
            throw new IllegalStateException("WHISPER_MODEL_STORAGE_UNAVAILABLE", error);
        }
        if (total != ASSET.size) throw new IllegalStateException("WHISPER_MODEL_SIZE_INVALID");
    }

    private static IllegalStateException downloadFailure(IOException error) {
        if (error instanceof SocketTimeoutException) {
            return new IllegalStateException("WHISPER_MODEL_NETWORK_TIMEOUT", error);
        }
        if (error instanceof UnknownHostException
                || error instanceof ConnectException
                || error instanceof NoRouteToHostException) {
            return new IllegalStateException("WHISPER_MODEL_NETWORK_UNAVAILABLE", error);
        }
        if (error instanceof SSLException) {
            return new IllegalStateException("WHISPER_MODEL_NETWORK_TLS_FAILED", error);
        }
        return new IllegalStateException("WHISPER_MODEL_DOWNLOAD_FAILED", error);
    }

    private static final class SourceReadException extends Exception {
        final IOException source;

        SourceReadException(IOException source) {
            super(source);
            this.source = source;
        }
    }

    private static boolean verify(File file) throws Exception {
        if (!file.isFile() || file.length() != ASSET.size) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1024 * 1024];
        try (InputStream input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder actual = new StringBuilder(64);
        for (byte value : digest.digest()) actual.append(String.format("%02x", value & 0xff));
        return ASSET.sha256.equals(actual.toString());
    }

    private static boolean verifyForInstall(
            File file, AtomicBoolean cancellation, String jobId, int base, int span)
            throws Exception {
        if (!file.isFile() || file.length() != ASSET.size) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1024 * 1024];
        long total = 0;
        try (InputStream input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (cancellation.get()) throw new IllegalStateException("WHISPER_CANCELLED");
                digest.update(buffer, 0, count);
                total += count;
                PROGRESS.put(jobId, base + (int) Math.min(span, total * span / ASSET.size));
            }
        }
        StringBuilder actual = new StringBuilder(64);
        for (byte value : digest.digest()) actual.append(String.format("%02x", value & 0xff));
        return ASSET.sha256.equals(actual.toString());
    }

    private static boolean verifyCached(File file) throws Exception {
        if (file.isFile() && file.length() == verifiedLength
                && file.lastModified() == verifiedLastModified) return true;
        boolean valid = verify(file);
        if (valid) rememberVerified(file);
        return valid;
    }

    private static void rememberVerified(File file) {
        verifiedLength = file.length();
        verifiedLastModified = file.lastModified();
    }

    private static File modelFile(Context context) {
        return new File(new File(new File(new File(context.getFilesDir(), "models"), ASSET.family),
            ASSET.revision), ASSET.fileName);
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }
}
