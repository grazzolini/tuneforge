use std::path::Path;

pub fn validate_ndk_revision(expected: &str, properties: &str) -> Result<(), String> {
    let actual = properties
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(name, _)| name.trim() == "Pkg.Revision")
        .map(|(_, value)| value.trim())
        .ok_or_else(|| "Android NDK Pkg.Revision must be present".to_string())?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Android whisper.cpp Vulkan shaders require pinned NDK {expected}; found {actual}"
        ))
    }
}

pub fn stage_native_source(source: &Path, out: &Path) -> Result<(), String> {
    let source_tree = source.join("whisper.cpp");
    let staged_tree = out.join("whisper.cpp");
    if !source_tree.is_dir() {
        return Err("prepared whisper.cpp source tree is missing".to_string());
    }
    if staged_tree.exists() {
        std::fs::remove_dir_all(&staged_tree).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(out).map_err(|error| error.to_string())?;
    fs_extra::dir::copy(&source_tree, out, &fs_extra::dir::CopyOptions::new())
        .map_err(|error| error.to_string())?;
    std::fs::copy(
        source.join(".tuneforge-source.json"),
        out.join(".tuneforge-whisper-source.json"),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn verify_staged_file(
    source: impl AsRef<Path>,
    staged: impl AsRef<Path>,
) -> Result<(), String> {
    let source = std::fs::read(source).map_err(|error| error.to_string())?;
    let staged = std::fs::read(staged).map_err(|error| error.to_string())?;
    if source == staged {
        Ok(())
    } else {
        Err("staged file differs from prepared source".to_string())
    }
}
