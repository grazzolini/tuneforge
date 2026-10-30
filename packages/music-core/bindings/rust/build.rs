use std::{env, fs, path::PathBuf, process::Command};

fn run(command: &mut Command) {
    assert!(
        command.status().expect("run core build tool").success(),
        "music-core build failed"
    );
}
fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap().parent().unwrap();
    assert!(root.join("vendor/gingo-src/LICENSE").is_file(),
        "Verified Gingo sources missing. Run node scripts/build-music-core.mjs --fetch-sources [--offline] from the repository root.");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("music-core");
    let cmake = env::var("TUNEFORGE_MUSIC_CORE_CMAKE").unwrap_or_else(|_| "cmake".into());
    let mut configure = Command::new(&cmake);
    configure
        .args(["-S"])
        .arg(root)
        .args(["-B"])
        .arg(&output)
        .arg("-DCMAKE_BUILD_TYPE=Release");
    for (environment, setting) in [
        ("TUNEFORGE_MUSIC_CORE_PYTHON", "Python_EXECUTABLE"),
        ("CMAKE_TOOLCHAIN_FILE", "CMAKE_TOOLCHAIN_FILE"),
        ("CMAKE_MAKE_PROGRAM", "CMAKE_MAKE_PROGRAM"),
    ] {
        println!("cargo:rerun-if-env-changed={environment}");
        if let Ok(value) = env::var(environment) {
            configure.arg(format!("-D{setting}={value}"));
        }
    }
    if env::var("CARGO_CFG_TARGET_OS").unwrap() == "android" {
        assert_eq!(
            env::var("TARGET").unwrap(),
            "aarch64-linux-android",
            "unsupported Android core target"
        );
        let ndk = PathBuf::from(env::var_os("ANDROID_NDK_HOME").expect("ANDROID_NDK_HOME"));
        configure.arg(format!(
            "-DCMAKE_TOOLCHAIN_FILE={}",
            ndk.join("build/cmake/android.toolchain.cmake").display()
        ));
        configure.args([
            "-DANDROID_ABI=arm64-v8a",
            "-DANDROID_PLATFORM=android-26",
            "-DANDROID_STL=c++_static",
        ]);
    } else if env::var("CARGO_CFG_TARGET_OS").unwrap() == "macos" {
        configure.arg("-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0");
    }
    run(&mut configure);
    run(Command::new(&cmake).args(["--build"]).arg(&output).args([
        "--parallel",
        "4",
        "--target",
        "tuneforge_music_abi_static",
    ]));
    println!("cargo:rustc-link-search=native={}", output.display());
    for library in [
        "tuneforge_music_core",
        "tuneforge_music_policies",
        "music_core_policy",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
    match env::var("CARGO_CFG_TARGET_OS").unwrap().as_str() {
        "macos" | "ios" => println!("cargo:rustc-link-lib=c++"),
        "android" => {
            let ndk = PathBuf::from(env::var_os("ANDROID_NDK_HOME").expect("ANDROID_NDK_HOME"));
            let prebuilt = ndk.join("toolchains/llvm/prebuilt");
            let host = fs::read_dir(prebuilt)
                .unwrap()
                .filter_map(Result::ok)
                .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .expect("NDK host toolchain")
                .path();
            let libraries = host.join("sysroot/usr/lib/aarch64-linux-android");
            let clang = host.join("lib/clang");
            let version = fs::read_dir(clang)
                .unwrap()
                .filter_map(Result::ok)
                .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .expect("NDK clang runtime")
                .path();
            // Expose only these archives: adding the NDK sysroot library directory
            // also makes the linker select static Bionic instead of its API stubs.
            let runtime = output.join("cxx-runtime");
            fs::create_dir_all(&runtime).expect("core C++ runtime directory");
            for (source, name) in [
                (libraries.join("libc++_static.a"), "libc++_static.a"),
                (libraries.join("libc++abi.a"), "libc++abi.a"),
                (version.join("lib/linux/aarch64/libunwind.a"), "libunwind.a"),
            ] {
                fs::copy(source, runtime.join(name)).expect("copy pinned NDK C++ runtime archive");
            }
            println!("cargo:rustc-link-search=native={}", runtime.display());
            for library in ["c++_static", "c++abi", "unwind"] {
                println!("cargo:rustc-link-lib=static={library}");
            }
        }
        _ => println!("cargo:rustc-link-lib=stdc++"),
    }
    for source in [
        "CMakeLists.txt",
        "sources.lock.json",
        "src",
        "include",
        "resources",
        "schema",
        "tools",
        "patches",
        "vendor",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(source).display());
    }
    println!("cargo:rerun-if-env-changed=TUNEFORGE_MUSIC_CORE_CMAKE");
}
