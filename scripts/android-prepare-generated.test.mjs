import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceScript = new URL("./android-prepare-generated.sh", import.meta.url);
const beatRunnerSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/BeatThisRunner.java",
  import.meta.url,
);
const cremaRunnerSource = new URL(
  "../apps/desktop/src-tauri/android/java/com/tuneforge/desktop/CremaRunner.java",
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
    inferenceLock: fs.readFileSync(path.join(java, "InferenceLock.java"), "utf8"),
    modelAsset: fs.readFileSync(path.join(java, "ModelAssetDescriptor.java"), "utf8"),
    beatRunnerSource: fs.readFileSync(beatRunnerSource, "utf8"),
    modelAssetSource: fs.readFileSync(modelAssetSource, "utf8"),
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
