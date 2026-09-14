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

cp "$TEMPLATE_ROOT/settings.gradle" "$ROOT/settings.gradle"
cp "$TEMPLATE_ROOT/build.gradle.kts" "$ROOT/build.gradle.kts"
cp "$TEMPLATE_ROOT/gradle.properties" "$ROOT/gradle.properties"

ANDROID_HOME_RESOLVED="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ -d "$ANDROID_HOME_RESOLVED" ]]; then
  printf 'sdk.dir=%s\n' "$ANDROID_HOME_RESOLVED" > "$ROOT/local.properties"
else
  echo "Android SDK not found at $ANDROID_HOME_RESOLVED; set ANDROID_HOME or create local.properties." >&2
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
