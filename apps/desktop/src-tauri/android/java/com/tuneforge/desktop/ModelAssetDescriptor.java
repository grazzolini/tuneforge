package com.tuneforge.desktop;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntConsumer;

final class ModelAssetDescriptor {
    final VerificationCache verification = new VerificationCache();

    private Boolean verifiedBundle;

    interface OpenAsset { InputStream open() throws Exception; }
    interface Verify { boolean run() throws Exception; }

    /** A cache hit requires the same path, inode, size, and nanosecond modification time. */
    static final class VerificationCache {
        private String verifiedStamp;
        private String stamp(java.io.File file) throws Exception {
            java.nio.file.attribute.BasicFileAttributes attributes;
            try { attributes = java.nio.file.Files.readAttributes(file.toPath(), java.nio.file.attribute.BasicFileAttributes.class); }
            catch (java.nio.file.NoSuchFileException missing) { return null; }
            if (!attributes.isRegularFile()) return null;
            return file.getCanonicalPath() + ":" + attributes.fileKey() + ":" + attributes.size() + ":" + attributes.lastModifiedTime();
        }
        synchronized boolean verify(java.io.File file, Verify verify) throws Exception {
            String before = stamp(file);
            if (before != null && before.equals(verifiedStamp)) return true;
            verifiedStamp = null;
            if (before == null) return false;
            if (!verify.run()) return false;
            String after = stamp(file);
            if (before == null || !before.equals(after)) return false;
            verifiedStamp = after;
            return true;
        }
    }

    final String family;
    final String revision;
    final String fileName;
    final String bundlePath;
    final String url;
    final long size;
    final String sha256;

    ModelAssetDescriptor(String family, String revision, String fileName, String bundlePath,
                         String url, long size, String sha256) {
        this.family = family;
        this.revision = revision;
        this.fileName = fileName;
        this.bundlePath = bundlePath;
        this.url = url;
        this.size = size;
        this.sha256 = sha256;
    }
    File cachedFile(File filesDir) {
        return new File(filesDir, "models/" + family + "/" + revision + "/" + fileName);
    }

    boolean verifiedFile(File file) throws Exception {
        return verifiedFile(file, () -> {});
    }

    private boolean verifiedFile(File file, Runnable check) throws Exception {
        if (Files.isSymbolicLink(file.toPath())) return false;
        return verification.verify(file, () -> {
            if (file.length() != size) return false;
            try (InputStream input = new FileInputStream(file)) {
                return verifyStream(input, check);
            }
        });
    }

    synchronized boolean verifiedBundle(OpenAsset bundle) throws Exception {
        if (verifiedBundle == null) {
            try (InputStream input = bundle.open()) {
                verifiedBundle = verifyStream(input, () -> {});
            } catch (FileNotFoundException missing) {
                verifiedBundle = false;
            }
        }
        return verifiedBundle;
    }

    File prepare(File filesDir, OpenAsset bundle, AtomicBoolean cancellation,
                 String prefix, IntConsumer progress) throws Exception {
        Runnable check = () -> {
            if (cancellation.get()) throw new IllegalStateException(prefix + "_CANCELLED");
        };
        File destination = cachedFile(filesDir);
        check.run();
        if (verifiedFile(destination, check)) return destination;
        File parent = destination.getParentFile();
        Files.createDirectories(parent.toPath());
        File temporary = new File(parent, "." + fileName + ".download");
        Files.deleteIfExists(temporary.toPath());
        if (parent.getUsableSpace() < size) throw new IllegalStateException(prefix + "_MODEL_STORAGE_INSUFFICIENT");
        try {
            if (!copyBundle(bundle, temporary, check, prefix, progress)) {
                download(temporary, check, prefix, progress);
            }
            check.run();
            Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
            return destination;
        } finally {
            Files.deleteIfExists(temporary.toPath());
        }
    }

    private boolean copyBundle(OpenAsset bundle, File temporary, Runnable check, String prefix,
                               IntConsumer progress) throws Exception {
        if (bundle == null) return false;
        InputStream source;
        try {
            source = bundle.open();
        } catch (FileNotFoundException missing) {
            return false;
        }
        try (InputStream input = source) {
            copyVerified(input, temporary, check, prefix, progress);
        }
        return true;
    }

    private void download(File temporary, Runnable check, String prefix, IntConsumer progress) throws Exception {
        check.run();
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("User-Agent", "TuneForge/1");
        connection.setInstanceFollowRedirects(true);
        try {
            int response = connection.getResponseCode();
            check.run();
            if (response < 200 || response >= 300) {
                throw new IllegalStateException(prefix + "_MODEL_DOWNLOAD_HTTP_" + response);
            }
            long declared = connection.getContentLengthLong();
            if (declared >= 0 && declared != size) {
                throw new IllegalStateException(prefix + "_MODEL_SIZE_INVALID");
            }
            try (InputStream input = connection.getInputStream()) {
                copyVerified(input, temporary, check, prefix, progress);
            }
        } finally {
            connection.disconnect();
        }
    }

    private void copyVerified(InputStream input, File temporary, Runnable check, String prefix,
                              IntConsumer progress) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1024 * 1024];
        long total = 0;
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            while (true) {
                check.run();
                int count = input.read(buffer);
                if (count == -1) break;
                total += count;
                if (total > size) throw new IllegalStateException(prefix + "_MODEL_SIZE_INVALID");
                digest.update(buffer, 0, count);
                output.write(buffer, 0, count);
                progress.accept((int) (100 * total / size));
            }
            if (total != size) throw new IllegalStateException(prefix + "_MODEL_SIZE_INVALID");
            if (!sha256.equals(hex(digest.digest()))) {
                throw new IllegalStateException(prefix + "_MODEL_INTEGRITY_FAILED");
            }
            output.getFD().sync();
        }
    }

    private boolean verifyStream(InputStream input, Runnable check) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1024 * 1024];
        long total = 0;
        while (true) {
            check.run();
            int count = input.read(buffer);
            if (count == -1) break;
            total += count;
            if (total > size) return false;
            digest.update(buffer, 0, count);
        }
        return total == size && sha256.equals(hex(digest.digest()));
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(64);
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
