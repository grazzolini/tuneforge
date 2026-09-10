fn main() {
    println!("cargo:rerun-if-env-changed=TUNEFORGE_GIT_REF");
    if let Some(git_ref) = git_ref() {
        println!("cargo:rustc-env=TUNEFORGE_GIT_REF={git_ref}");
    }
    build_android_ffmpeg_bridge();
    tauri_build::build()
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
