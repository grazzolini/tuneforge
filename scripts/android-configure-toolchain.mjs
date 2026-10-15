import fs from "node:fs";
import path from "node:path";
import { androidToolchainProfiles, compareVersions, readLocalNdkPath, readLocalSdkPath } from "./android-toolchain.mjs";

// Tauri CLI 2.12.1 templates; patch releases retain Java 17 and release R8 fixes.
export const androidGradleVersions = androidToolchainProfiles[0];

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Generated Android ${label} marker is missing; no toolchain files changed.`);
  return source.replace(pattern, replacement);
}

export function configureAndroidToolchain(baseDir, { profile = "current", compileSdk, compileSdkMinor, buildToolsVersion, ndkRevision, ndkRoot, sdkRoot }) {
  const versions = androidToolchainProfiles.find((candidate) => candidate.id === profile);
  if (!versions || !Number.isInteger(compileSdk) || compileSdk < versions.minimumSdk || compileSdk > versions.maximumSdk ||
      (profile === "baseline" && compileSdkMinor !== undefined) || !/^\d+(?:\.\d+)+$/.test(buildToolsVersion) ||
      compareVersions(buildToolsVersion, versions.minimumBuildTools) < 0 ||
      !/^\d+(?:\.\d+)+$/.test(ndkRevision) || typeof ndkRoot !== "string" || !path.isAbsolute(ndkRoot) ||
      (sdkRoot !== undefined && (typeof sdkRoot !== "string" || !path.isAbsolute(sdkRoot))) ||
      (compileSdkMinor !== undefined && (!Number.isSafeInteger(compileSdkMinor) || compileSdkMinor < 0))) {
    throw new Error("Selected Android toolchain versions or absolute NDK root are invalid.");
  }
  const localProperties = path.join(baseDir, "local.properties");
  const localNdkPath = readLocalNdkPath(localProperties);
  const localSdkPath = sdkRoot === undefined ? undefined : readLocalSdkPath(localProperties);
  const canonical = (candidate) => {
    try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
  };
  if (localNdkPath && canonical(localNdkPath) !== canonical(ndkRoot)) {
    throw new Error("local.properties ndk.dir conflicts with the selected NDK. Remove or align ndk.dir; no toolchain files changed.");
  }
  if (sdkRoot !== undefined && localSdkPath && canonical(localSdkPath) !== canonical(sdkRoot)) {
    throw new Error("local.properties sdk.dir conflicts with the selected SDK. Remove or align sdk.dir; no toolchain files changed.");
  }
  const kotlinNdkPath = JSON.stringify(ndkRoot).replaceAll("$", "\\$");
  const changes = [];
  const transform = (relative, configure) => {
    const file = path.join(baseDir, relative);
    const original = fs.readFileSync(file, "utf8");
    changes.push({ file, original, contents: configure(original) });
  };
  for (const relative of ["build.gradle.kts", "buildSrc/build.gradle.kts"]) {
    transform(relative, (source) => {
      let result = replaceRequired(source, /com\.android\.tools\.build:gradle:[\d.]+/g,
        `com.android.tools.build:gradle:${versions.agp}`, "AGP");
      if (relative === "build.gradle.kts") {
        result = replaceRequired(result, /org\.jetbrains\.kotlin:kotlin-gradle-plugin:[\d.]+/g,
          `org.jetbrains.kotlin:kotlin-gradle-plugin:${versions.kotlin}`, "Kotlin plugin");
        const block = ["// TUNEFORGE-BUILD-TOOLS-BEGIN", "subprojects {",
          '    plugins.withId("com.android.application") {',
          "        extensions.getByType(com.android.build.api.variant.ApplicationAndroidComponentsExtension::class.java).finalizeDsl { dsl ->",
          `            dsl.buildToolsVersion = "${buildToolsVersion}"`,
          "        }", "    }",
          '    plugins.withId("com.android.library") {',
          "        extensions.getByType(com.android.build.api.variant.LibraryAndroidComponentsExtension::class.java).finalizeDsl { dsl ->",
          `            dsl.buildToolsVersion = "${buildToolsVersion}"`,
          "        }", "    }", "}", "// TUNEFORGE-BUILD-TOOLS-END"].join("\n");
        result = result.replace(/^\/\/ TUNEFORGE-BUILD-TOOLS-BEGIN\n[\s\S]*?^\/\/ TUNEFORGE-BUILD-TOOLS-END\n?/gm, "").trimEnd();
        result = `${result}\n\n${block}\n`;
      }
      return result;
    });
  }
  transform("app/build.gradle.kts", (source) => {
    source = source.replace(/^[ \t]*compileSdkMinor\s*=.*\r?\n/gm, "");
    let result = replaceRequired(source, /\bcompileSdk\s*=\s*\d+/, `compileSdk = ${compileSdk}`, "compileSdk");
    if (compileSdkMinor !== undefined) result = result.replace(/\bcompileSdk\s*=\s*\d+/,
      `compileSdk = ${compileSdk}\n    compileSdkMinor = ${compileSdkMinor}`);
    result = replaceRequired(result, /\btargetSdk\s*=\s*\d+/, "targetSdk = 36", "targetSdk");
    if (!/\bminSdk\s*=\s*26\b/.test(result)) throw new Error("Generated Android minSdk must remain 26; no toolchain files changed.");
    result = result.replace(/^\s*(?:ndkVersion|ndkPath|buildToolsVersion)\s*=.*\n/gm, "");
    const ndkPath = localNdkPath ? "" : `\n    ndkPath = ${kotlinNdkPath}`;
    result = replaceRequired(result, /android\s*\{/, () => `android {\n    ndkVersion = "${ndkRevision}"${ndkPath}\n    buildToolsVersion = "${buildToolsVersion}"`, "android block");
    if (/\bkotlinOptions\s*\{/.test(result)) {
      result = replaceRequired(result, /    kotlinOptions\s*\{\s*jvmTarget\s*=\s*"1\.8"\s*\}\r?\n/,
        /\bcompileOptions\s*\{/.test(result) ? "" : "    compileOptions {\n        sourceCompatibility = JavaVersion.VERSION_1_8\n        targetCompatibility = JavaVersion.VERSION_1_8\n    }\n", "legacy Kotlin target");
      result = `import org.jetbrains.kotlin.gradle.dsl.JvmTarget\n${result}`;
      result = `${result.trimEnd()}\n\nkotlin {\n    compilerOptions {\n        jvmTarget = JvmTarget.JVM_1_8\n    }\n}\n`;
    }
    if (!/compilerOptions\s*\{\s*jvmTarget\s*=\s*JvmTarget\.JVM_1_8/.test(result)) {
      throw new Error("Generated Android Kotlin compilerOptions marker is missing; no toolchain files changed.");
    }
    if (result.includes('getDefaultProguardFile("proguard-android-optimize.txt")')) {
      result = replaceRequired(result,
        /\*fileTree\("\."\)\s*\{\s*include\("\*\*\/\*\.pro"\)\s*(?:exclude\("build\/\*\*"\)\s*)?\}\s*\.plus\(getDefaultProguardFile\("proguard-android-optimize\.txt"\)\)\s*\.toList\(\)\.toTypedArray\(\)/,
        '*fileTree(".") {\n                  include("**/*.pro")\n                  exclude("build/**")\n                }.files.toTypedArray()', "legacy ProGuard");
    }
    const release = /getByName\("release"\)\s*\{([\s\S]*?)proguardFiles\(/;
    result = replaceRequired(result, release, (match) => {
      if (/optimization\s*\{\s*enable\s*=\s*true/.test(match)) return match;
      return replaceRequired(match, /isMinifyEnabled\s*=\s*true/,
        "optimization {\n               enable = true\n            }", "release optimization");
    }, "release ProGuard");
    result = replaceRequired(result, /\nkotlin\s*\{\s*compilerOptions\s*\{\s*jvmTarget\s*=\s*JvmTarget\.JVM_1_8\s*\}\s*\}\s*/,
      "\n", "Kotlin compilerOptions");
    result = result.replace(/^import org\.jetbrains\.kotlin\.gradle\.dsl\.JvmTarget\r?\n/m, "");
    if (profile === "current") {
      result = `import org.jetbrains.kotlin.gradle.dsl.JvmTarget\n${result.trimEnd()}\n\nkotlin {\n    compilerOptions {\n        jvmTarget = JvmTarget.JVM_1_8\n    }\n}\n`;
    } else {
      result = replaceRequired(result, /    buildFeatures\s*\{/,
        '    kotlinOptions {\n        jvmTarget = "1.8"\n    }\n    buildFeatures {', "Kotlin options insertion");
      result = replaceRequired(result, release, (match) => replaceRequired(match,
        /optimization\s*\{\s*enable\s*=\s*true\s*\}/, "isMinifyEnabled = true", "release optimization"), "release ProGuard");
      result = replaceRequired(result,
        /\*fileTree\("\."\)\s*\{\s*include\("\*\*\/\*\.pro"\)\s*exclude\("build\/\*\*"\)\s*\}\.files\.toTypedArray\(\)/,
        '*fileTree(".") {\n                  include("**/*.pro")\n                  exclude("build/**")\n                }.plus(getDefaultProguardFile("proguard-android-optimize.txt")).toList().toTypedArray()', "optimized ProGuard");
    }
    return `${result.replace('apply(from = "tauri.build.gradle.kts")', 'apply(from = file("tauri.build.gradle.kts"))').trimEnd()}\n`;
  });
  transform("buildSrc/src/main/java/com/tuneforge/desktop/kotlin/BuildTask.kt", (source) => {
    if (!source.includes("project.exec {")) {
      if (!source.includes("execOperations.exec {") || !source.includes("var projectDir: String?")) {
        throw new Error("Generated Android BuildTask is unrecognized; no toolchain files changed.");
      }
      return source;
    }
    let result = replaceRequired(source, /open class BuildTask : DefaultTask\(\) \{/,
      "abstract class BuildTask : DefaultTask() {\n    @get:Inject\n    abstract val execOperations: ExecOperations", "BuildTask class");
    result = `import javax.inject.Inject\nimport org.gradle.process.ExecOperations\n${result}`;
    result = replaceRequired(result, /    @Input\n    var target:/,
      "    @Input\n    var projectDir: String? = null\n    @Input\n    var target:", "BuildTask target");
    result = result.replace("project.exec {", "execOperations.exec {");
    result = replaceRequired(result, /File\(project\.projectDir, rootDirRel\)/,
      "File(projectDir, rootDirRel)", "BuildTask working directory");
    return result.replaceAll("project.logger.isEnabled", "logger.isEnabled");
  });
  transform("buildSrc/src/main/java/com/tuneforge/desktop/kotlin/RustPlugin.kt", (source) => {
    if (!source.includes("project.tasks.maybeCreate(")) {
      if (!source.includes("project.tasks.register(") || !source.includes("projectDir = project.projectDir.path")) {
        throw new Error("Generated Android RustPlugin is unrecognized; no toolchain files changed.");
      }
      return source;
    }
    let result = source.replace("project.tasks.maybeCreate(", "project.tasks.register(");
    result = replaceRequired(result, /BuildTask::class\.java\s*\)\.apply \{/,
      "BuildTask::class.java\n                    ) {", "RustPlugin task registration");
    return replaceRequired(result, /rootDirRel = config\.rootDirRel/,
      "rootDirRel = config.rootDirRel\n                        projectDir = project.projectDir.path", "RustPlugin working directory");
  });
  transform("gradle.properties", (source) => {
    let result = source.replace(/^[ \t]*android\.(?:useAndroidX|builtInKotlin|newDsl|proguard\.failOnMissingFiles|builder\.sdkDownload)[ \t]*[=:][^\r\n]*\r?\n?/gm, "");
    const properties = profile === "current" ? ["android.builtInKotlin=false", "android.newDsl=false", "android.proguard.failOnMissingFiles=false"] : [];
    for (const property of [...properties, "android.useAndroidX=true", "android.builder.sdkDownload=false"]) {
      const name = property.split("=")[0].replaceAll(".", "\\.");
      const pattern = new RegExp(`^${name}=.*$`, "m");
      result = pattern.test(result) ? result.replace(pattern, property) : `${result.trimEnd()}\n${property}\n`;
    }
    return result;
  });
  transform("gradle/wrapper/gradle-wrapper.properties", (source) => {
    let result = replaceRequired(source, /^distributionUrl=.*gradle-[\d.]+-(?:bin|all)\.zip$/m,
      `distributionUrl=https\\://services.gradle.org/distributions/gradle-${versions.gradle}-bin.zip`, "Gradle distribution");
    // Keep the generated bootstrap JAR; only the distribution changes.
    const checksum = /^distributionSha256Sum=.*$/m;
    result = checksum.test(result) ? result.replace(checksum, `distributionSha256Sum=${versions.gradleSha256}`)
      : `${result.trimEnd()}\ndistributionSha256Sum=${versions.gradleSha256}\n`;
    return result;
  });
  // Validate every migration marker before the first write; restore on a write failure.
  try {
    for (const change of changes) if (change.contents !== change.original) fs.writeFileSync(change.file, change.contents);
  } catch (error) {
    for (const change of changes) fs.writeFileSync(change.file, change.original);
    throw error;
  }
}
