fn main() {
    println!("cargo:rerun-if-env-changed=TUNEFORGE_GIT_REF");
    if let Some(git_ref) = git_ref() {
        println!("cargo:rustc-env=TUNEFORGE_GIT_REF={git_ref}");
    }
    build_soxr_bridge();
    build_android_ffmpeg_bridge();
    tauri_build::build()
}

fn build_soxr_bridge() {
    let android = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android");
    let variable = if android {
        "TUNEFORGE_ANDROID_SOXR_ROOT"
    } else {
        "TUNEFORGE_SOXR_ROOT"
    };
    println!("cargo:rerun-if-env-changed={variable}");
    let Ok(root) = std::env::var(variable) else {
        if android {
            panic!("{variable} is required for Android builds");
        }
        return;
    };
    let root = std::path::PathBuf::from(root);
    let include = root.join("include");
    let library = root.join("lib");
    let provenance = root.join("provenance.json");
    if !include.join("soxr.h").is_file() || !library.is_dir() || !provenance.is_file() {
        panic!(
            "verified libsoxr headers/libraries missing at {}",
            root.display()
        );
    }
    let provenance_json = std::fs::read_to_string(&provenance)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", provenance.display()));
    if !provenance_json.contains("\"-DWITH_PFFFT=ON\"") {
        panic!(
            "verified libsoxr runtime at {} does not use the required PFFFT profile",
            root.display()
        );
    }
    cc::Build::new()
        .file("src/native_audio/soxr_bridge.c")
        .include(&include)
        .flag_if_supported("-std=c11")
        .warnings(true)
        .compile("tuneforge_soxr_bridge");
    println!("cargo:rustc-link-search=native={}", library.display());
    println!("cargo:rustc-link-lib=dylib=soxr");
    println!("cargo:rerun-if-changed=src/native_audio/soxr_bridge.c");
    println!("cargo:rerun-if-changed=src/native_audio/soxr_bridge.h");
    println!("cargo:rerun-if-changed={}", provenance.display());
}

fn build_android_ffmpeg_bridge() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") {
        return;
    }
    let root = std::env::var("TUNEFORGE_ANDROID_FFMPEG_ROOT")
        .expect("TUNEFORGE_ANDROID_FFMPEG_ROOT is required for Android builds");
    let root = std::path::PathBuf::from(root);
    let include = root.join("include");
    let library = root.join("lib");
    if !include.is_dir() || !library.is_dir() {
        panic!(
            "verified Android FFmpeg headers/libraries missing at {}",
            root.display()
        );
    }
    cc::Build::new()
        .file("src/mobile_ffmpeg/bridge.c")
        .include(&include)
        .flag_if_supported("-std=c11")
        .warnings(true)
        .compile("tuneforge_ffmpeg_bridge");
    println!("cargo:rustc-link-search=native={}", library.display());
    for library in [
        "avfilter",
        "avformat",
        "avcodec",
        "swresample",
        "avutil",
        "mp3lame",
    ] {
        println!("cargo:rustc-link-lib=dylib={library}");
    }
    println!("cargo:rerun-if-env-changed=TUNEFORGE_ANDROID_FFMPEG_ROOT");
    println!("cargo:rerun-if-changed=src/mobile_ffmpeg/bridge.c");
    println!("cargo:rerun-if-changed=src/mobile_ffmpeg/bridge.h");
}

fn git_ref() -> Option<String> {
    std::env::var("TUNEFORGE_GIT_REF")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("git")
                .args([
                    "describe",
                    "--tags",
                    "--long",
                    "--dirty",
                    "--always",
                    "--abbrev=8",
                ])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}
