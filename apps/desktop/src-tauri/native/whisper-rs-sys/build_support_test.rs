mod build_support;

use std::path::PathBuf;

#[test]
fn accepts_only_the_pinned_shader_ndk_revision() {
    const PINNED: &str = "29.0.14206865";
    assert!(build_support::validate_ndk_revision(
        PINNED,
        "Pkg.Desc = Android NDK\nPkg.Revision = 29.0.14206865\n",
    )
    .is_ok());
    assert_eq!(
        build_support::validate_ndk_revision(PINNED, "Pkg.Revision = 30.0.10000000\n").unwrap_err(),
        "Android whisper.cpp Vulkan shaders require pinned NDK 29.0.14206865; found 30.0.10000000"
    );
    assert_eq!(
        build_support::validate_ndk_revision(PINNED, "Pkg.Desc = Android NDK\n").unwrap_err(),
        "Android NDK Pkg.Revision must be present"
    );
}

#[test]
fn replaces_stale_native_source_when_the_prepared_identity_changes() {
    let root = temporary_root();
    let out = root.join("out");
    let first = prepared_source(&root, "first", "old", true);
    build_support::stage_native_source(&first, &out).unwrap();
    assert_eq!(
        std::fs::read_to_string(out.join("whisper.cpp/src/whisper.cpp")).unwrap(),
        "old"
    );
    assert!(out.join("whisper.cpp/src/stale.cpp").is_file());

    let second = prepared_source(&root, "second", "corrected", false);
    build_support::stage_native_source(&second, &out).unwrap();
    build_support::verify_staged_file(
        second.join("whisper.cpp/src/whisper.cpp"),
        out.join("whisper.cpp/src/whisper.cpp"),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(out.join(".tuneforge-whisper-source.json")).unwrap(),
        "{\"identity\":\"second\"}\n"
    );
    assert!(!out.join("whisper.cpp/src/stale.cpp").exists());
    std::fs::remove_dir_all(root).unwrap();
}

fn temporary_root() -> PathBuf {
    let unique = format!(
        "tuneforge-whisper-build-support-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn prepared_source(root: &std::path::Path, identity: &str, contents: &str, stale: bool) -> PathBuf {
    let source = root.join(identity);
    let tree = source.join("whisper.cpp/src");
    std::fs::create_dir_all(&tree).unwrap();
    std::fs::write(tree.join("whisper.cpp"), contents).unwrap();
    if stale {
        std::fs::write(tree.join("stale.cpp"), "stale").unwrap();
    }
    std::fs::write(
        source.join(".tuneforge-source.json"),
        format!("{{\"identity\":\"{identity}\"}}\n"),
    )
    .unwrap();
    source
}
