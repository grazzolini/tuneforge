import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceScript = new URL("./android-prepare-generated.sh", import.meta.url);

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = endMarker === null
    ? source.length
    : source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
}

function generatedProject(t) {
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
  fs.writeFileSync(path.join(tauri, "proguard-tuneforge.pro"), "# test\n");

  const icons = path.join(tauri, "target/android-icons/android");
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi", "anydpi-v26"]) {
    fs.mkdirSync(path.join(icons, `mipmap-${density}`), { recursive: true });
  }
  fs.mkdirSync(path.join(icons, "values"), { recursive: true });
  fs.writeFileSync(path.join(icons, "values/ic_launcher_background.xml"), "<resources />\n");

  execFileSync(script, { cwd: root });
  return {
    activity: fs.readFileSync(path.join(java, "MainActivity.kt"), "utf8"),
    service: fs.readFileSync(path.join(java, "PowerInhibitionService.kt"), "utf8"),
  };
}

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
