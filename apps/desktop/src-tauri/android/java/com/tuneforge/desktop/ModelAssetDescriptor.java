package com.tuneforge.desktop;

final class ModelAssetDescriptor {
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
