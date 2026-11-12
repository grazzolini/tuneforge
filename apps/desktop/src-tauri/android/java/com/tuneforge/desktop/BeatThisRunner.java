package com.tuneforge.desktop;

import android.content.Context;
import java.io.File;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.pytorch.executorch.EValue;
import org.pytorch.executorch.Tensor;

final class BeatThisRunner {
    private static final ModelAssetDescriptor ASSET = new ModelAssetDescriptor(
        "beat-this", "895b249c4ccabaedc0770b12935c2b7b2f60e145", "beat-this-small0.pte",
        "models/beat-this/beat-this-small0.pte",
        "https://huggingface.co/grazzolini/tuneforge-models/resolve/895b249c4ccabaedc0770b12935c2b7b2f60e145/beat-this/beat-this-small0.pte",
        9820680L, "03b512e135edeb4f4644a7f05fa13ae20ba676484997548f81118fec13d42293");
    private static final ConcurrentHashMap<String, AtomicBoolean> CANCELLATIONS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> LAST_ERRORS = new ConcurrentHashMap<>();
    private static org.pytorch.executorch.Module module;
    private static String modulePath;

    private BeatThisRunner() {}

    static String status(Context context) {
        File model = ASSET.cachedFile(context.getFilesDir());
        if (!model.exists()) return "download-required";
        try {
            return ASSET.verifiedFile(model) ? "ready" : "corrupt";
        } catch (Exception ignored) {
            return "unavailable";
        }
    }

    static float[][] run(Context context, float[] input, int frames, String jobId) {
        if (frames < 13 || frames > 1500 || input.length != frames * 128) {
            throw new IllegalArgumentException("BEAT_THIS_INPUT_SHAPE_INVALID");
        }
        if (jobId == null || jobId.isEmpty()) throw new IllegalArgumentException("BEAT_THIS_JOB_ID_INVALID");
        AtomicBoolean cancellation = CANCELLATIONS.computeIfAbsent(jobId, ignored -> new AtomicBoolean(false));
        LAST_ERRORS.remove(jobId);
        try {
            synchronized (InferenceLock.LOCK) {
                if (cancellation.get()) throw new IllegalStateException("BEAT_THIS_CANCELLED");
                File modelFile = prepare(context, cancellation);
                if (cancellation.get()) throw new IllegalStateException("BEAT_THIS_CANCELLED");
                if (module == null || !modelFile.getAbsolutePath().equals(modulePath)) {
                    if (module != null) module.destroy();
                    module = org.pytorch.executorch.Module.load(modelFile.getAbsolutePath());
                    modulePath = modelFile.getAbsolutePath();
                }
                EValue[] output = module.forward(EValue.from(Tensor.fromBlob(input,
                    new long[] {1, frames, 128}))) ;
                if (cancellation.get()) throw new IllegalStateException("BEAT_THIS_CANCELLED");
                if (output.length != 2) throw new IllegalStateException("BEAT_THIS_OUTPUT_SHAPE_INVALID");
                Tensor beatTensor = output[0].toTensor();
                Tensor downbeatTensor = output[1].toTensor();
                long[] beatShape = beatTensor.shape();
                long[] downbeatShape = downbeatTensor.shape();
                if (beatShape.length != 2 || beatShape[0] != 1 || beatShape[1] != frames
                    || downbeatShape.length != 2 || downbeatShape[0] != 1
                    || downbeatShape[1] != frames) {
                    throw new IllegalStateException("BEAT_THIS_OUTPUT_SHAPE_INVALID");
                }
                float[] beat = beatTensor.getDataAsFloatArray();
                float[] downbeat = downbeatTensor.getDataAsFloatArray();
                if (beat.length != frames || downbeat.length != frames) {
                    throw new IllegalStateException("BEAT_THIS_OUTPUT_SHAPE_INVALID");
                }
                return new float[][] { beat, downbeat };
            }
        } catch (RuntimeException error) {
            String code = error.getMessage();
            LAST_ERRORS.put(jobId, code == null ? "BEAT_THIS_RUNTIME_FAILED" : code);
            throw error;
        } finally {
            CANCELLATIONS.remove(jobId, cancellation);
        }
    }

    static String takeError(String jobId) {
        String code = LAST_ERRORS.remove(jobId);
        return code == null ? "BEAT_THIS_RUNTIME_FAILED" : code;
    }

    static void cancel(String jobId) {
        if (jobId != null && !jobId.isEmpty()) {
            CANCELLATIONS.computeIfAbsent(jobId, ignored -> new AtomicBoolean(false)).set(true);
        }
    }

    private static File prepare(Context context, AtomicBoolean cancellation) {
        try {
            return ASSET.prepare(context.getFilesDir(), () -> context.getAssets().open(ASSET.bundlePath),
                cancellation, "BEAT_THIS", ignored -> {});
        } catch (IllegalStateException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalStateException("BEAT_THIS_MODEL_DOWNLOAD_FAILED", error);
        }
    }
}
