mod build_support;

mod upstream {
    include!(concat!(
        env!("TUNEFORGE_WHISPER_RS_SYS_SOURCE"),
        "/build.rs"
    ));
}

fn verify_android_vulkan_toolchain(source: &str) {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android")
        || std::env::var_os("CARGO_FEATURE_VULKAN").is_none()
    {
        return;
    }
    let expected = std::fs::read_to_string(format!("{source}/.tuneforge-vulkan-ndk-revision"))
        .expect("prepared whisper-rs-sys source must declare its pinned Vulkan NDK revision");
    let expected = expected.trim();
    let ndk = std::env::var("ANDROID_NDK_HOME")
        .or_else(|_| std::env::var("ANDROID_NDK_ROOT"))
        .expect("ANDROID_NDK_HOME is required for Android Vulkan builds");
    let properties = std::fs::read_to_string(format!("{ndk}/source.properties"))
        .expect("Android NDK source.properties is required for Vulkan builds");
    build_support::validate_ndk_revision(expected, &properties)
        .unwrap_or_else(|error| panic!("{error}"));
    let host = std::env::var("HOST").expect("Cargo HOST is required for Vulkan builds");
    let shader_host = if host.contains("apple-darwin") {
        "darwin-x86_64"
    } else if host.contains("linux") {
        "linux-x86_64"
    } else {
        panic!("unsupported host for pinned Android Vulkan shader compilation: {host}");
    };
    let glslc = format!("{ndk}/shader-tools/{shader_host}/glslc");
    assert!(
        std::path::Path::new(&glslc).is_file(),
        "pinned Android NDK glslc is missing"
    );
    println!("cargo:rerun-if-changed={ndk}/source.properties");
    println!("cargo:rerun-if-changed={glslc}");
    println!("cargo:rustc-env=TUNEFORGE_WHISPER_VULKAN_NDK_REVISION={expected}");
}

fn main() {
    println!("cargo:rerun-if-env-changed=TUNEFORGE_WHISPER_RS_SYS_SOURCE");
    let source = std::env::var("TUNEFORGE_WHISPER_RS_SYS_SOURCE")
        .expect("scripts/android-arm64-env.sh must prepare the pinned whisper-rs-sys source");
    verify_android_vulkan_toolchain(&source);
    let out = std::env::var("OUT_DIR").expect("Cargo OUT_DIR is required");
    build_support::stage_native_source(std::path::Path::new(&source), std::path::Path::new(&out))
        .unwrap_or_else(|error| panic!("failed to stage exact whisper.cpp source: {error}"));
    println!("cargo:rerun-if-changed={source}/.tuneforge-source.json");
    std::env::set_current_dir(&source).unwrap_or_else(|error| {
        panic!("failed to enter prepared whisper-rs-sys source {source}: {error}")
    });
    upstream::build();
    for relative in [
        "whisper.cpp/src/whisper.cpp",
        "whisper.cpp/src/tuneforge_dtw.h",
        "whisper.cpp/src/tuneforge_text.h",
        "whisper.cpp/ggml/src/ggml-backend-reg.cpp",
    ] {
        build_support::verify_staged_file(
            std::path::Path::new(&source).join(relative),
            std::path::Path::new(&out).join(relative),
        )
        .unwrap_or_else(|error| panic!("staged native source provenance failed: {error}"));
    }
}
