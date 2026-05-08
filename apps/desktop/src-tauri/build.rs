fn main() {
    println!("cargo:rerun-if-env-changed=TUNEFORGE_GIT_REF");
    if let Some(git_ref) = git_ref() {
        println!("cargo:rustc-env=TUNEFORGE_GIT_REF={git_ref}");
    }
    tauri_build::build()
}

fn git_ref() -> Option<String> {
    std::env::var("TUNEFORGE_GIT_REF")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("git")
                .args(["describe", "--tags", "--long", "--dirty", "--always"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}
