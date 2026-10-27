package com.tuneforge.desktop;

final class ModelAssetDescriptor {
    final VerificationCache verification = new VerificationCache();

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
}
