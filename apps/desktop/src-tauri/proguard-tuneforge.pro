-keepclassmembers class com.tuneforge.desktop.MainActivity {
    public java.lang.String setTuneForgePowerInhibition(int);
    public java.lang.String getTuneForgePowerInhibitionStatus();
    public java.lang.String getTuneForgeAudioPermissionState();
    public java.lang.String requestTuneForgeAudioPermission();
    public java.lang.String getTuneForgeBeatThisStatus();
    public float[][] runTuneForgeBeatThis(float[],int,java.lang.String);
    public java.lang.String takeTuneForgeBeatThisError(java.lang.String);
    public void cancelTuneForgeBeatThis(java.lang.String);
    public java.lang.String getTuneForgeCremaStatus();
    public java.lang.String prepareTuneForgeCrema(java.lang.String);
    public float[][] runTuneForgeCrema(float[],int,java.lang.String);
    public java.lang.String takeTuneForgeCremaError(java.lang.String);
    public void cancelTuneForgeCrema(java.lang.String);
    public java.lang.String getTuneForgeWhisperStatus();
    public java.lang.String prepareTuneForgeWhisper(java.lang.String);
    public java.lang.String takeTuneForgeWhisperError(java.lang.String);
    public void cancelTuneForgeWhisper(java.lang.String);
    public int getTuneForgeWhisperProgress(java.lang.String);
    public void clearTuneForgeWhisperProgress(java.lang.String);
    public java.lang.Object getTuneForgeInferenceLock();
}

# Keep the pinned ExecuTorch JNI surface and its fbjni exception bridge stable under R8.
-keep class org.pytorch.executorch.** { *; }
# fbjni 0.7.0 has no consumer rules; native exception translation requires these Java names.
-keep class com.facebook.jni.** { *; }
# ONNX Runtime resolves its Java/JNI entry points by their published names.
-keep class ai.onnxruntime.** { *; }
