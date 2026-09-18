import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { resolveJava } from "./package-android.mjs";

const sourceScript = new URL("./android-prepare-generated.sh", import.meta.url);
const beatRunnerSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/BeatThisRunner.java",
  import.meta.url,
);
const cremaRunnerSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/CremaRunner.java",
  import.meta.url,
);
const whisperModelInstallerSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/WhisperModelInstaller.java",
  import.meta.url,
);
const inferenceLockSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/InferenceLock.java",
  import.meta.url,
);
const modelAssetSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/ModelAssetDescriptor.java",
  import.meta.url,
);
const mainActivitySource = new URL(
  "../apps/desktop/src-tauri/android/kotlin/com/tuneforge/desktop/MainActivity.kt",
  import.meta.url,
);
const whisperNativePatchSource = new URL(
  "./patches/whisper-rs-sys-0.15.0-tuneforge.patch",
  import.meta.url,
);
const whisperDtwHelperSource = new URL(
  "../apps/desktop/src-tauri/native/whisper-rs-sys/tuneforge_dtw.h",
  import.meta.url,
);
const whisperTextHelperSource = new URL(
  "../apps/desktop/src-tauri/native/whisper-rs-sys/tuneforge_text.h",
  import.meta.url,
);
const powerServiceSource = new URL(
  "../apps/desktop/src-tauri/android/kotlin/com/tuneforge/desktop/PowerInhibitionService.kt",
  import.meta.url,
);
function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = endMarker === null
    ? source.length
    : source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
}

function addedPatchSection(source, startMarker, endMarker) {
  return section(source, startMarker, endMarker)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("Whisper native patch preserves desktop forced-alignment inputs and confidence", () => {
  const source = fs.readFileSync(whisperNativePatchSource, "utf8");
  const alignment = section(
    source,
    "+    // Match OpenAI's forced-alignment decoder input exactly:",
    "     const auto n_audio_tokens = n_frames/2;",
  );
  const task = alignment.indexOf("whisper_token_transcribe(ctx)");
  const prefixLength = alignment.indexOf("const size_t sot_sequence_length");
  const noTimestamps = alignment.indexOf("whisper_token_not(ctx)");
  assert.ok(task >= 0 && task < prefixLength && prefixLength < noTimestamps);
  assert.match(alignment, /state->batch\.logits\[i\] = 1/);
  assert.match(alignment, /params\.abort_callback, params\.abort_callback_user_data/);
  assert.match(alignment, /\(sot_sequence_length \+ i\) \* n_vocab/);
  assert.match(alignment, /const int text_vocab = whisper_token_eot\(ctx\)/);
});

test("Whisper native patch preserves desktop DTW, suppression, and fallback semantics", () => {
  const source = fs.readFileSync(whisperNativePatchSource, "utf8");
  const dtwHelper = fs.readFileSync(whisperDtwHelperSource, "utf8");
  const textHelper = fs.readFileSync(whisperTextHelperSource, "utf8");
  assert.match(dtwHelper, /std::vector<double> cost/);
  assert.match(textHelper, /Z_DEFAULT_COMPRESSION/);
  assert.match(source, /token < whisper_token_beg\(ctx\)/);
  assert.match(source, /tuneforge::compression_ratio/);
  assert.match(source, /\(high_compression \|\| low_logprob\) && !silence/);

  const ratio = (text) => {
    const bytes = Buffer.from(text.trim(), "utf8");
    return bytes.length / deflateSync(bytes).length;
  };
  assert.equal(ratio(""), 0);
  assert.equal(ratio("a short nonrepetitive sentence"), 30 / 38);
  assert.equal(ratio(" \u3000Olá ♪ 世界\u00a0 "), 15 / 24);
  assert.equal(Buffer.from([0xe2, 0x99]).toString("utf8"), "�");
  assert.equal(Buffer.from([0xe0, 0x80]).toString("utf8"), "��");
  assert.equal(Buffer.from([0xed, 0xa0]).toString("utf8"), "��");
  assert.equal(Buffer.from([0xf0, 0x80, 0x80]).toString("utf8"), "���");
  assert.equal(ratio("abc ".repeat(200)), 799 / 19);

  let state = 1;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const words = Array.from({ length: 80 }, () => random().toString(36).slice(2));
  const base = words.join(" ");
  const below = `${base} ${words.slice(0, 27).join(" ").repeat(2)}`;
  const above = `${base} ${words.slice(0, 28).join(" ").repeat(2)}`;
  assert.equal(Buffer.byteLength(below), 1580);
  assert.equal(deflateSync(below).length, 665);
  assert.ok(ratio(below) < 2.4);
  assert.equal(Buffer.byteLength(above), 1604);
  assert.equal(deflateSync(above).length, 664);
  assert.ok(ratio(above) > 2.4);
});

test("Whisper production DTW helper preserves the desktop near-tie path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-whisper-dtw-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "dtw_test.cpp");
  const executable = path.join(root, "dtw_test");
  fs.writeFileSync(source, `
#include "tuneforge_dtw.h"
#include <array>
#include <cstdio>
int main() {
  const float matrix[4][6] = {
    {1.0000003576278687f, 0.9999998211860657f, 0.9999998807907104f, 0.9999995827674866f, 0.9999997019767761f, 0.9999998807907104f},
    {1.0000003576278687f, 0.9999998211860657f, 1.0f, 1.0000001192092896f, 1.0000001192092896f, 1.0000003576278687f},
    {1.0000001192092896f, 0.9999998211860657f, 0.9999997019767761f, 1.0000001192092896f, 1.000000238418579f, 1.0000003576278687f},
    {1.0000003576278687f, 1.0000003576278687f, 1.000000238418579f, 1.000000238418579f, 0.9999998807907104f, 1.0000003576278687f},
  };
  const std::array<tuneforge::DtwPoint, 6> expected = {{{0, 0}, {1, 1}, {2, 2}, {2, 3}, {3, 4}, {3, 5}}};
  const auto path = tuneforge::dtw_path(4, 6, [&](int64_t token, int64_t frame) {
    return matrix[token][frame];
  });
  if (path.size() != expected.size()) return 1;
  for (size_t index = 0; index < path.size(); ++index) {
    if (path[index].token != expected[index].token || path[index].frame != expected[index].frame) {
      for (const auto & point : path) {
        std::fprintf(stderr, "%lld,%lld ", static_cast<long long>(point.token),
            static_cast<long long>(point.frame));
      }
      std::fprintf(stderr, "\\n");
      return 2;
    }
  }
  return 0;
}
`);
  execFileSync("c++", ["-std=c++17", "-I", path.dirname(fileURLToPath(whisperDtwHelperSource)),
    source, "-o", executable]);
  execFileSync(executable);
});

test("Whisper production alignment helper normalizes only usable frames", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-whisper-alignment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "alignment_test.cpp");
  const executable = path.join(root, "alignment_test");
  fs.writeFileSync(source, `
#include "tuneforge_dtw.h"
#include <cmath>
int main() {
  const auto complete = tuneforge::validate_dtw_boundaries({0, 2, 4}, 2);
  if (!complete.valid() || complete.expected != 3 || complete.emitted != 3 ||
      complete.missing != 0 || complete.reversed != 0 || complete.first_jump != 0) return 1;
  const auto missing = tuneforge::validate_dtw_boundaries({0, 2}, 2);
  if (missing.valid() || missing.missing != 1 || missing.reversed != 0) return 2;
  const auto absent = tuneforge::validate_dtw_boundaries({0, -1, 4}, 2);
  if (absent.valid() || absent.missing != 1 || absent.reversed != 0) return 3;
  const auto reversed = tuneforge::validate_dtw_boundaries({0, 4, 2}, 2);
  if (reversed.valid() || reversed.missing != 0 || reversed.reversed != 1) return 4;

  // Two tokens, three retained frames, one head. Each token originally had
  // probability mass in clipped frames, so the retained slice does not sum to one.
  float values[] = {0.10f, 0.10f, 0.20f, 0.20f, 0.10f, 0.50f};
  if (!tuneforge::renormalize_clipped_attention(values, 2, 3, 1)) return 5;
  // Retained frame softmax mass is restored independently for each token.
  const float token0 = values[0] + values[2] + values[4];
  const float token1 = values[1] + values[3] + values[5];
  if (std::abs(token0 - 1.0f) > 1e-6f) return 6;
  if (std::abs(token1 - 1.0f) > 1e-6f) return 7;
  if (!tuneforge::standardize_attention_tokens(values, 2, 3, 1)) return 8;
  // The subsequent token-axis standardization produces zero mean per frame.
  if (std::abs(values[0] + values[1]) > 1e-6f) return 9;
  if (std::abs(values[2] + values[3]) > 1e-6f) return 10;
  if (std::abs(values[4] + values[5]) > 1e-6f) return 11;
  return 0;
}
`);
  execFileSync("c++", ["-std=c++17", "-I", path.dirname(fileURLToPath(whisperDtwHelperSource)),
    source, "-o", executable]);
  execFileSync(executable);
});

test("Whisper production text helper matches desktop UTF-8 and zlib behavior", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-whisper-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "text_test.cpp");
  const executable = path.join(root, "text_test");
  fs.writeFileSync(source, `
#include "tuneforge_text.h"
#include <cmath>
int main() {
  const std::string replacement("\\xEF\\xBF\\xBD", 3);
  if (tuneforge::python_decode_utf8_replace(std::string("\\xE2\\x99", 2)) != replacement) return 1;
  if (tuneforge::python_decode_utf8_replace(std::string("\\xE0\\x80", 2)) != replacement + replacement) return 2;
  if (tuneforge::python_decode_utf8_replace(std::string("\\xED\\xA0", 2)) != replacement + replacement) return 3;
  if (tuneforge::python_decode_utf8_replace(std::string("\\xF0\\x80\\x80", 3)) != replacement + replacement + replacement) return 4;
  if (std::abs(tuneforge::compression_ratio("") - 0.0) > 1e-12) return 5;
  if (std::abs(tuneforge::compression_ratio("a short nonrepetitive sentence") - (30.0 / 38.0)) > 1e-12) return 6;
  std::string repetitive;
  for (int index = 0; index < 200; ++index) repetitive += "abc ";
  if (std::abs(tuneforge::compression_ratio(repetitive) - (799.0 / 19.0)) > 1e-12) return 7;
  return 0;
}
`);
  execFileSync("c++", ["-std=c++17", "-I", path.dirname(fileURLToPath(whisperTextHelperSource)),
    source, "-lz", "-o", executable]);
  execFileSync(executable);
});

test("Whisper backend provenance uses completed inference graph assignments", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-whisper-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patch = fs.readFileSync(whisperNativePatchSource, "utf8");
  const productionClassifier = addedPatchSection(
    patch,
    "+static constexpr int32_t WHISPER_BACKEND_MASK_CPU",
    "\n static bool ggml_graph_compute_helper(",
  );
  const source = path.join(root, "backend_test.cpp");
  const executable = path.join(root, "backend_test");
  fs.writeFileSync(source, `
#include <cstdint>
enum ggml_op {
  GGML_OP_NONE, GGML_OP_DUP, GGML_OP_ADD, GGML_OP_SET, GGML_OP_CPY,
  GGML_OP_CONT, GGML_OP_RESHAPE, GGML_OP_VIEW, GGML_OP_PERMUTE,
  GGML_OP_TRANSPOSE, GGML_OP_MUL_MAT, GGML_OP_SOFT_MAX,
};
enum ggml_backend_dev_type {
  GGML_BACKEND_DEVICE_TYPE_CPU,
  GGML_BACKEND_DEVICE_TYPE_GPU,
  GGML_BACKEND_DEVICE_TYPE_IGPU,
  GGML_BACKEND_DEVICE_TYPE_ACCEL,
};
struct fake_device { ggml_backend_dev_type type; };
struct fake_backend { fake_device * device; };
using ggml_backend_dev_t = fake_device *;
using ggml_backend_t = fake_backend *;
struct ggml_backend_sched {};
using ggml_backend_sched_t = ggml_backend_sched *;
struct ggml_tensor { ggml_op op; ggml_backend_t assigned; };
struct ggml_cgraph { int n_nodes; ggml_tensor ** nodes; };
static int ggml_graph_n_nodes(ggml_cgraph * graph) { return graph->n_nodes; }
static ggml_tensor * ggml_graph_node(ggml_cgraph * graph, int index) { return graph->nodes[index]; }
static ggml_backend_t ggml_backend_sched_get_tensor_backend(ggml_backend_sched_t, ggml_tensor * node) { return node->assigned; }
static ggml_backend_dev_t ggml_backend_get_device(ggml_backend_t backend) { return backend->device; }
static ggml_backend_dev_type ggml_backend_dev_type(ggml_backend_dev_t device) { return device->type; }
${productionClassifier}
int main() {
  fake_device cpu_device{GGML_BACKEND_DEVICE_TYPE_CPU};
  fake_device gpu_device{GGML_BACKEND_DEVICE_TYPE_GPU};
  fake_backend cpu{&cpu_device};
  fake_backend gpu{&gpu_device};
  ggml_backend_sched sched;

  // GPU exists, but only a copy node is assigned to it. Inference ran on CPU.
  ggml_tensor cpu_compute{GGML_OP_MUL_MAT, &cpu};
  ggml_tensor gpu_copy{GGML_OP_CPY, &gpu};
  ggml_tensor * registered_unused_nodes[]{&cpu_compute, &gpu_copy};
  ggml_cgraph registered_unused{2, registered_unused_nodes};
  int32_t mask = 0;
  whisper_record_completed_graph(true, &sched, &registered_unused, &mask);
  if (whisper_backend_type_from_mask(mask) != 0) return 1;

  ggml_tensor gpu_compute{GGML_OP_MUL_MAT, &gpu};
  ggml_tensor * gpu_nodes[]{&gpu_compute};
  ggml_cgraph gpu_graph{1, gpu_nodes};
  mask = 0;
  whisper_record_completed_graph(true, &sched, &gpu_graph, &mask);
  if (whisper_backend_type_from_mask(mask) != 1) return 2;

  ggml_tensor cpu_add{GGML_OP_ADD, &cpu};
  ggml_tensor gpu_softmax{GGML_OP_SOFT_MAX, &gpu};
  ggml_tensor * mixed_nodes[]{&cpu_add, &gpu_softmax};
  ggml_cgraph mixed_graph{2, mixed_nodes};
  mask = 0;
  whisper_record_completed_graph(true, &sched, &mixed_graph, &mask);
  if (whisper_backend_type_from_mask(mask) != 1) return 3;

  mask = 0;
  whisper_record_completed_graph(false, &sched, &gpu_graph, &mask);
  if (whisper_backend_type_from_mask(mask) != -1) return 4;

  ggml_cgraph empty_graph{0, nullptr};
  mask = 0;
  whisper_record_completed_graph(true, &sched, &empty_graph, &mask);
  if (whisper_backend_type_from_mask(mask) != -1) return 5;

  ggml_tensor unknown_compute{GGML_OP_MUL_MAT, nullptr};
  ggml_tensor * partly_unknown_nodes[]{&cpu_compute, &unknown_compute};
  ggml_cgraph partly_unknown{2, partly_unknown_nodes};
  mask = 0;
  whisper_record_completed_graph(true, &sched, &partly_unknown, &mask);
  if (whisper_backend_type_from_mask(mask) != -1) return 6;
  return 0;
}
`);
  execFileSync("c++", ["-std=c++17", source, "-o", executable]);
  execFileSync(executable);
});

function generatedProject(t, { soxrProfile = "ON" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-android-generated-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const script = path.join(root, "scripts/android-prepare-generated.sh");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(sourceScript, script);
  fs.chmodSync(script, 0o755);

  const tauri = path.join(root, "apps/desktop/src-tauri");
  const main = path.join(tauri, "gen/android/app/src/main");
  const java = path.join(main, "java/com/tuneforge/desktop");
  fs.mkdirSync(java, { recursive: true });
  fs.mkdirSync(path.join(main, "res"), { recursive: true });
  fs.writeFileSync(path.join(main, "AndroidManifest.xml"), "<manifest>\n  <application>\n  </application>\n</manifest>\n");
  fs.writeFileSync(path.join(java, "MainActivity.kt"), "placeholder\n");
  fs.writeFileSync(path.join(tauri, "gen/android/app/build.gradle.kts"), "dependencies {\n}\n");
  fs.writeFileSync(path.join(tauri, "proguard-tuneforge.pro"), "# test\n");

  const javaSource = path.join(tauri, "android/java/com/tuneforge/desktop");
  fs.mkdirSync(javaSource, { recursive: true });
  fs.copyFileSync(beatRunnerSource, path.join(javaSource, "BeatThisRunner.java"));
  fs.copyFileSync(cremaRunnerSource, path.join(javaSource, "CremaRunner.java"));
  fs.copyFileSync(whisperModelInstallerSource, path.join(javaSource, "WhisperModelInstaller.java"));
  fs.copyFileSync(inferenceLockSource, path.join(javaSource, "InferenceLock.java"));
  fs.copyFileSync(modelAssetSource, path.join(javaSource, "ModelAssetDescriptor.java"));
  const kotlinSource = path.join(tauri, "android/kotlin/com/tuneforge/desktop");
  fs.mkdirSync(kotlinSource, { recursive: true });
  fs.copyFileSync(mainActivitySource, path.join(kotlinSource, "MainActivity.kt"));
  fs.copyFileSync(powerServiceSource, path.join(kotlinSource, "PowerInhibitionService.kt"));

  const icons = path.join(tauri, "target/android-icons/android");
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi", "anydpi-v26"]) {
    fs.mkdirSync(path.join(icons, `mipmap-${density}`), { recursive: true });
  }
  fs.mkdirSync(path.join(icons, "values"), { recursive: true });
  fs.writeFileSync(path.join(icons, "values/ic_launcher_background.xml"), "<resources />\n");

  const ffmpeg = path.join(root, "owned-ffmpeg");
  fs.mkdirSync(path.join(ffmpeg, "lib"), { recursive: true });
  fs.mkdirSync(path.join(ffmpeg, "licenses"), { recursive: true });
  for (const library of ["libavcodec.so", "libavfilter.so", "libavformat.so", "libavutil.so",
    "libswresample.so", "libmp3lame.so"]) {
    fs.writeFileSync(path.join(ffmpeg, "lib", library), `fixture ${library}\n`);
  }
  fs.writeFileSync(path.join(ffmpeg, "provenance.json"), "{}\n");
  fs.writeFileSync(path.join(ffmpeg, "licenses", "FFmpeg-COPYING.LGPLv2.1.txt"), "fixture\n");
  fs.writeFileSync(path.join(ffmpeg, "licenses", "LAME-COPYING.LGPL-2.0.txt"), "fixture\n");

  const soxr = path.join(root, "owned-soxr");
  fs.mkdirSync(path.join(soxr, "lib"), { recursive: true });
  fs.mkdirSync(path.join(soxr, "licenses"), { recursive: true });
  fs.writeFileSync(path.join(soxr, "lib/libsoxr.so"), "fixture libsoxr\n");
  fs.writeFileSync(path.join(soxr, "provenance.json"), `${JSON.stringify({
    cmake: [`-DWITH_PFFFT=${soxrProfile}`],
  })}\n`);
  fs.writeFileSync(path.join(soxr, "licenses/libsoxr-LICENCE.txt"), "fixture\n");
  execFileSync(script, { cwd: root, env: { ...process.env, TUNEFORGE_ANDROID_FFMPEG_ROOT: ffmpeg,
    TUNEFORGE_ANDROID_SOXR_ROOT: soxr } });
  return {
    activity: fs.readFileSync(path.join(java, "MainActivity.kt"), "utf8"),
    service: fs.readFileSync(path.join(java, "PowerInhibitionService.kt"), "utf8"),
    beatRunner: fs.readFileSync(path.join(java, "BeatThisRunner.java"), "utf8"),
    cremaRunner: fs.readFileSync(path.join(java, "CremaRunner.java"), "utf8"),
    whisperModelInstaller: fs.readFileSync(path.join(java, "WhisperModelInstaller.java"), "utf8"),
    inferenceLock: fs.readFileSync(path.join(java, "InferenceLock.java"), "utf8"),
    modelAsset: fs.readFileSync(path.join(java, "ModelAssetDescriptor.java"), "utf8"),
    beatRunnerSource: fs.readFileSync(beatRunnerSource, "utf8"),
    modelAssetSource: fs.readFileSync(modelAssetSource, "utf8"),
    whisperModelInstallerSource: fs.readFileSync(whisperModelInstallerSource, "utf8"),
    activitySource: fs.readFileSync(mainActivitySource, "utf8"),
    serviceSource: fs.readFileSync(powerServiceSource, "utf8"),
    gradle: fs.readFileSync(path.join(tauri, "gen/android/app/build.gradle.kts"), "utf8"),
  };
}

test("preparation copies maintained Beat This Java sources", (t) => {
  const { beatRunner, beatRunnerSource, modelAsset, modelAssetSource } = generatedProject(t);
  assert.equal(beatRunner, beatRunnerSource);
  assert.equal(modelAsset, modelAssetSource);
});

test("preparation copies the Whisper installer with explicit error results", (t) => {
  const { whisperModelInstaller, whisperModelInstallerSource } = generatedProject(t);
  assert.equal(whisperModelInstaller, whisperModelInstallerSource);
  assert.match(
    whisperModelInstaller,
    /catch \(Exception error\) \{\s+String code = error\.getMessage\(\);\s+LAST_ERRORS\.put\(jobId,[\s\S]*?return "";\s+\}/,
  );
  for (const code of [
    "WHISPER_MODEL_NETWORK_TIMEOUT",
    "WHISPER_MODEL_NETWORK_UNAVAILABLE",
    "WHISPER_MODEL_NETWORK_TLS_FAILED",
    "WHISPER_MODEL_DOWNLOAD_FAILED",
    "WHISPER_MODEL_SETUP_FAILED",
  ]) {
    assert.match(whisperModelInstaller, new RegExp(`"${code}"`));
  }
  assert.match(
    whisperModelInstaller,
    /code != null && code\.startsWith\("WHISPER_"\)[\s\S]*?"WHISPER_MODEL_SETUP_FAILED"/,
  );
  assert.match(
    whisperModelInstaller,
    /static String status\(Context context\)[\s\S]*?if \(!installInProgress[\s\S]*?recoverInterruptedInstall\(familyRoot, targetRoot, model\);[\s\S]*?return verifyCached\(model\) \? "ready" : "corrupt";/,
  );
});

test("Whisper installer preserves active staging and classifies destination failures", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tuneforge-whisper-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "src");
  const classes = path.join(root, "classes");
  const androidContent = path.join(sourceRoot, "android", "content");
  const androidResources = path.join(androidContent, "res");
  const packageRoot = path.join(sourceRoot, "com", "tuneforge", "desktop");
  fs.mkdirSync(androidResources, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(classes);
  fs.writeFileSync(path.join(androidContent, "Context.java"), `
package android.content;
import android.content.res.AssetManager;
import java.io.File;
public abstract class Context {
  public abstract AssetManager getAssets();
  public abstract File getFilesDir();
}
`);
  fs.writeFileSync(path.join(androidResources, "AssetManager.java"), `
package android.content.res;
import java.io.FileNotFoundException;
import java.io.InputStream;
public class AssetManager {
  public InputStream open(String path) throws FileNotFoundException {
    throw new FileNotFoundException(path);
  }
}
`);
  for (const source of [whisperModelInstallerSource, inferenceLockSource, modelAssetSource]) {
    fs.copyFileSync(source, path.join(packageRoot, path.basename(fileURLToPath(source))));
  }
  const harness = path.join(packageRoot, "WhisperModelInstallerHarness.java");
  fs.writeFileSync(harness, `
package com.tuneforge.desktop;

import android.content.Context;
import android.content.res.AssetManager;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class WhisperModelInstallerHarness {
  private static final class TestContext extends Context {
    private final File files;
    TestContext(File files) { this.files = files; }
    @Override public AssetManager getAssets() { return new AssetManager(); }
    @Override public File getFilesDir() { return files; }
  }

  private static final class BlockingInput extends InputStream {
    final CountDownLatch reading = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);
    private boolean finished;
    @Override public int read() { throw new AssertionError("bulk read expected"); }
    @Override public int read(byte[] buffer, int offset, int length) throws java.io.IOException {
      if (finished) return -1;
      reading.countDown();
      try { release.await(); }
      catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new java.io.IOException(error);
      }
      finished = true;
      buffer[offset] = 1;
      return 1;
    }
  }

  public static void main(String[] args) throws Exception {
    File files = new File(args[0]);
    File family = new File(new File(files, "models"), "whisper");
    File staging = new File(family,
        ".98aa99a0a9db05ae2342309f5096248665f7cba3.test.staging");
    if (!staging.mkdirs()) throw new AssertionError("staging creation failed");
    File temporary = new File(staging, "ggml-large-v3-turbo.bin");

    Field stateLockField = WhisperModelInstaller.class.getDeclaredField("INSTALL_STATE_LOCK");
    stateLockField.setAccessible(true);
    Object stateLock = stateLockField.get(null);
    Field activeField = WhisperModelInstaller.class.getDeclaredField("installInProgress");
    activeField.setAccessible(true);
    synchronized (stateLock) { activeField.setBoolean(null, true); }

    Method copy = WhisperModelInstaller.class.getDeclaredMethod(
        "copy", InputStream.class, File.class, AtomicBoolean.class, String.class);
    copy.setAccessible(true);
    BlockingInput input = new BlockingInput();
    AtomicReference<Throwable> workerFailure = new AtomicReference<>();
    Thread worker = new Thread(() -> {
      try {
        copy.invoke(null, input, temporary, new AtomicBoolean(false), "job");
        throw new AssertionError("short copy should fail verification");
      } catch (InvocationTargetException error) {
        if (!"WHISPER_MODEL_SIZE_INVALID".equals(error.getCause().getMessage())) {
          workerFailure.set(error.getCause());
        }
      } catch (ReflectiveOperationException error) {
        workerFailure.set(error);
      }
    });
    worker.start();
    input.reading.await();
    WhisperModelInstaller.status(new TestContext(files));
    if (!staging.isDirectory()) throw new AssertionError("status deleted active staging");
    input.release.countDown();
    worker.join();
    if (workerFailure.get() != null) throw new AssertionError(workerFailure.get());
    synchronized (stateLock) { activeField.setBoolean(null, false); }
    WhisperModelInstaller.status(new TestContext(files));
    if (staging.exists()) throw new AssertionError("inactive staging was not reconciled");

    File destinationDirectory = new File(files, "destination-directory");
    if (!destinationDirectory.mkdir()) throw new AssertionError("destination creation failed");
    try {
      copy.invoke(null, new ByteArrayInputStream(new byte[] {1}), destinationDirectory,
          new AtomicBoolean(false), "job");
      throw new AssertionError("destination failure expected");
    } catch (InvocationTargetException error) {
      if (!"WHISPER_MODEL_STORAGE_UNAVAILABLE".equals(error.getCause().getMessage())) {
        throw new AssertionError(error.getCause());
      }
    }
  }
}
`);
  const { home } = resolveJava();
  const javac = path.join(home, "bin", "javac");
  const java = path.join(home, "bin", "java");
  const sources = [
    path.join(androidContent, "Context.java"),
    path.join(androidResources, "AssetManager.java"),
    path.join(packageRoot, "WhisperModelInstaller.java"),
    path.join(packageRoot, "InferenceLock.java"),
    path.join(packageRoot, "ModelAssetDescriptor.java"),
    harness,
  ];
  execFileSync(javac, ["-d", classes, ...sources]);
  execFileSync(java, ["-cp", classes, "com.tuneforge.desktop.WhisperModelInstallerHarness",
    path.join(root, "files")]);
});

test("preparation copies maintained Crema sources and pins ONNX Runtime", (t) => {
  const { cremaRunner, inferenceLock, gradle } = generatedProject(t);
  assert.equal(cremaRunner, fs.readFileSync(cremaRunnerSource, "utf8"));
  assert.equal(inferenceLock, fs.readFileSync(inferenceLockSource, "utf8"));
  assert.match(gradle, /com\.microsoft\.onnxruntime:onnxruntime-android:1\.29\.0/);
});

test("preparation rejects a stale PFFFT-disabled libsoxr runtime", (t) => {
  assert.throws(() => generatedProject(t, { soxrProfile: "OFF" }));
});

test("preparation copies maintained Android Kotlin sources", (t) => {
  const { activity, activitySource, service, serviceSource } = generatedProject(t);
  assert.equal(activity, activitySource);
  assert.equal(service, serviceSource);
});

test("maintained Beat This runtime pins and verifies the Android model", (t) => {
  const { activity, beatRunnerSource, modelAssetSource, gradle } = generatedProject(t);
  assert.match(gradle, /org\.pytorch:executorch-android:1\.4\.0/);
  assert.match(activity, /runTuneForgeBeatThis\(input: FloatArray, frames: Int, jobId: String\)/);
  assert.match(activity, /takeTuneForgeBeatThisError\(jobId: String\)/);
  assert.match(modelAssetSource, /final String sha256/);
  assert.match(beatRunnerSource, /9820680L/);
  assert.match(beatRunnerSource, /03b512e135edeb4f4644a7f05fa13ae20ba676484997548f81118fec13d42293/);
  assert.match(beatRunnerSource, /new long\[\] \{1, frames, 128\}/);
  assert.match(beatRunnerSource, /output\.length != 2/);
  assert.match(beatRunnerSource, /long\[\] beatShape = beatTensor\.shape\(\)/);
  assert.match(beatRunnerSource, /long\[\] downbeatShape = downbeatTensor\.shape\(\)/);
  assert.match(beatRunnerSource, /beatShape\.length != 2 \|\| beatShape\[0\] != 1 \|\| beatShape\[1\] != frames/);
  assert.match(beatRunnerSource, /downbeatShape\.length != 2 \|\| downbeatShape\[0\] != 1/);
  assert.match(beatRunnerSource, /downbeatShape\[1\] != frames/);
  assert.match(beatRunnerSource, /output\.getFD\(\)\.sync\(\)/);
  assert.match(beatRunnerSource, /temporary\.renameTo\(destination\)/);
  assert.match(beatRunnerSource, /LAST_ERRORS\.put\(jobId/);
});

test("generated screen protection is revision-gated to the current activity", (t) => {
  const { activity, service } = generatedProject(t);

  assert.match(activity, /applyTuneForgeScreenProtection\(expectedRevision: Long\)/);
  assert.match(activity, /screenProtectionRequestedMask\(this, expectedRevision\) \?: return@post/);
  assert.match(service, /activity\.get\(\) !== currentActivity \|\| expectedRevision != screenProtectionRevision\.get\(\)/);

  const desired = service.indexOf("desiredScreenMask = nextMask and SCREEN_REASON_MASK");
  const revision = service.indexOf("val revision = screenProtectionRevision.incrementAndGet()", desired);
  const apply = service.indexOf("activity.get()?.applyTuneForgeScreenProtection(revision)", revision);
  assert.ok(desired >= 0 && desired < revision && revision < apply);
});

test("generated desired masks publish through one synchronized transition", (t) => {
  const { service } = generatedProject(t);

  assert.match(service, /@Synchronized\n    private fun transitionDesiredState\(/);
  assert.match(service, /fun request\(context: Context, reasonMask: Int\): String \{\n      val transition = transitionDesiredState\(reasonMask, 0\)/);
  assert.match(service, /override fun onTimeout[\s\S]*transitionDesiredState\(null, REASON_SYNC_TRANSFER\)/);

  const desiredWrites = [...service.matchAll(
    /^\s*(desiredMask|desiredServiceMask|desiredScreenMask)\s*=(?!=)/gm,
  )];
  assert.deepEqual(desiredWrites.map((match) => match[1]), [
    "desiredMask", "desiredServiceMask", "desiredScreenMask",
  ]);
});

test("generated service failures are gated by the attempted ownership snapshot", (t) => {
  const { service } = generatedProject(t);
  const applyReasons = section(
    service,
    "  private fun applyReasons(",
    "  private fun startTruthfulForegroundNotification()",
  );
  const launch = section(
    service,
    "    private fun launch(",
    "    @Synchronized\n    private fun transitionDesiredState(",
  );
  const failureGate = section(
    service,
    "    private fun recordPowerControlFailure(",
    "  }\n\n  private fun applyOnMainThread()",
  );

  assert.match(service, /data class DesiredStateTransition\([\s\S]*serviceMask: Int,[\s\S]*serviceRevision: Long/);
  assert.match(applyReasons, /recordPowerControlFailure\(attemptedState\)/);
  assert.match(launch, /recordPowerControlFailure\(attemptedState\)/);
  assert.match(failureGate, /attemptedState\.serviceRevision != serviceOwnershipRevision\.get\(\) \|\|[\s\S]*attemptedState\.serviceMask != desiredServiceMask[\s\S]*\) return\n      transitionDesiredState\(null, SERVICE_REASON_MASK\)[\s\S]*lastFailure = ERROR_POWER_CONTROL/);
});

test("generated activity directly adds and clears the window flag before guarded confirmation", (t) => {
  const { activity, service } = generatedProject(t);

  assert.match(activity, /window\.addFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
  assert.match(activity, /window\.clearFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
  assert.match(activity, /confirmScreenProtection\(this, requestedMask, expectedRevision\)/);
  assert.match(service, /reasonMask != desiredScreenMask/);
  assert.doesNotMatch(activity, /decorView\.keepScreenOn/);
});

test("generated queued service work applies the latest desired mask", (t) => {
  const { service } = generatedProject(t);
  const onStart = section(service, "  override fun onStartCommand(", "  override fun onDestroy() {");
  const onDestroy = section(service, "  override fun onDestroy() {", "  override fun onBind(");
  const request = section(
    service,
    "    fun request(context: Context, reasonMask: Int): String {",
    "    fun status(): String {",
  );
  const mainThreadApply = section(service, "  private fun applyOnMainThread() {", null);

  assert.match(onStart, /applyReasons\(desiredServiceState\(\)\)/);
  assert.match(onDestroy, /val remainingState = desiredServiceState\(\)[\s\S]*launch\(applicationContext, remainingState\)/);
  assert.match(request, /launch\(context, transition\)/);
  assert.match(mainThreadApply, /handler\.post \{ applyReasons\(desiredServiceState\(\)\) \}/);
  assert.doesNotMatch(mainThreadApply, /applyReasons\(requestedMask\)/);
});
