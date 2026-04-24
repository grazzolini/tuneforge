#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_ROOT="$ROOT/apps/desktop/src-tauri/gen/android"
BUILDSRC_PACKAGE="com/tuneforge/desktop/kotlin"

if [[ ! -f "$ANDROID_ROOT/settings.gradle" ]]; then
  echo "Tauri Android target not found. Run: pnpm --filter @tuneforge/desktop tauri android init" >&2
  exit 1
fi

cat > "$ROOT/settings.gradle" <<'GRADLE'
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

include ':app'
project(':app').projectDir = new File(rootDir, 'apps/desktop/src-tauri/gen/android/app')

apply from: 'apps/desktop/src-tauri/gen/android/tauri.settings.gradle'
GRADLE

cat > "$ROOT/build.gradle.kts" <<'GRADLE'
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
GRADLE

cat > "$ROOT/gradle.properties" <<'PROPERTIES'
# Project-wide Gradle settings for local Android Studio root import.
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
android.nonFinalResIds=false
targetList=aarch64
archList=arm64
abiList=arm64-v8a
PROPERTIES

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
