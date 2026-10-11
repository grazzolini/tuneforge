#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_ROOT="$ROOT/apps/desktop/src-tauri/gen/android"
BUILDSRC_PACKAGE="com/tuneforge/desktop/kotlin"
TEMPLATE_ROOT="$ROOT/scripts/android-studio-root-shim-templates"

if [[ ! -f "$ANDROID_ROOT/settings.gradle" ]]; then
  echo "Tauri Android target not found. Run: pnpm --filter @tuneforge/desktop tauri android init" >&2
  exit 1
fi

LOCAL_PROPERTIES_CONTENTS="$(node --input-type=module - "$ROOT/scripts/android-toolchain.mjs" "$ANDROID_ROOT/app/build.gradle.kts" <<'NODE'
import { pathToFileURL } from "node:url";
const { readGeneratedSdk, resolveGeneratedSdk, readGeneratedNdk, escapeLocalProperty } = await import(pathToFileURL(process.argv[2]));
let required, recorded;
try { required = readGeneratedSdk(process.argv[3]); recorded = readGeneratedNdk(process.argv[3], { requireVersion: false }); }
catch (error) { console.error(error.message); process.exit(1); }
try {
  const sdk = resolveGeneratedSdk(required);
  process.stdout.write([`sdk.dir=${escapeLocalProperty(sdk)}`,
    ...(recorded.localPath ? [`ndk.dir=${escapeLocalProperty(recorded.localPath)}`] : [])].join("\n"));
} catch (error) {
  console.error(error.message);
  if (required.path || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) process.exitCode = 1;
}
NODE
)"

cp "$TEMPLATE_ROOT/settings.gradle" "$ROOT/settings.gradle"
cp "$ANDROID_ROOT/build.gradle.kts" "$ROOT/build.gradle.kts"
sed -E '/^[[:blank:]]*(targetList|archList|abiList|android\.builder\.sdkDownload)[[:blank:]]*[=:]/d' \
  "$ANDROID_ROOT/gradle.properties" > "$ROOT/gradle.properties"
printf '\n' >> "$ROOT/gradle.properties"
cat "$TEMPLATE_ROOT/gradle.properties" >> "$ROOT/gradle.properties"

if [[ -n "$LOCAL_PROPERTIES_CONTENTS" ]]; then
  printf '%s\n' "$LOCAL_PROPERTIES_CONTENTS" > "$ROOT/local.properties"
else
  echo "Set ANDROID_HOME or configure local.properties manually; existing local.properties is preserved." >&2
fi

mkdir -p "$ROOT/gradle/wrapper"
cp "$ANDROID_ROOT/gradlew" "$ROOT/gradlew"
cp "$ANDROID_ROOT/gradlew.bat" "$ROOT/gradlew.bat"
cp "$ANDROID_ROOT/gradle/wrapper/gradle-wrapper.jar" "$ROOT/gradle/wrapper/gradle-wrapper.jar"
cp "$ANDROID_ROOT/gradle/wrapper/gradle-wrapper.properties" "$ROOT/gradle/wrapper/gradle-wrapper.properties"
chmod +x "$ROOT/gradlew"

mkdir -p "$ROOT/buildSrc/src/main/java/$BUILDSRC_PACKAGE"
cp "$ANDROID_ROOT/buildSrc/build.gradle.kts" "$ROOT/buildSrc/build.gradle.kts"
cp "$ANDROID_ROOT/buildSrc/src/main/java/$BUILDSRC_PACKAGE/BuildTask.kt" \
  "$ROOT/buildSrc/src/main/java/$BUILDSRC_PACKAGE/BuildTask.kt"
cp "$ANDROID_ROOT/buildSrc/src/main/java/$BUILDSRC_PACKAGE/RustPlugin.kt" \
  "$ROOT/buildSrc/src/main/java/$BUILDSRC_PACKAGE/RustPlugin.kt"

RUST_PLUGIN="$ROOT/buildSrc/src/main/java/$BUILDSRC_PACKAGE/RustPlugin.kt"
perl -0pi -e 's/defaultArchList\.forEachIndexed/archList.forEachIndexed/g; s/defaultAbiList\[index\]/abiList[index]/g' "$RUST_PLUGIN"

echo "Android Studio root shim written. Open repo root in Studio and sync Gradle."
