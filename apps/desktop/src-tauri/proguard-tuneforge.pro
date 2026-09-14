-keepclassmembers class com.tuneforge.desktop.MainActivity {
    public java.lang.String setTuneForgePowerInhibition(int);
    public java.lang.String getTuneForgePowerInhibitionStatus();
    public java.lang.String getTuneForgeAudioPermissionState();
    public java.lang.String requestTuneForgeAudioPermission();
    public java.lang.String getTuneForgeBeatThisStatus();
    public float[][] runTuneForgeBeatThis(float[],int,java.lang.String);
    public java.lang.String takeTuneForgeBeatThisError(java.lang.String);
    public void cancelTuneForgeBeatThis(java.lang.String);
}

# Keep the pinned ExecuTorch JNI surface and its fbjni exception bridge stable under R8.
-keep class org.pytorch.executorch.** { *; }
# fbjni 0.7.0 has no consumer rules; native exception translation requires these Java names.
-keep class com.facebook.jni.** { *; }
