use std::path::PathBuf;

pub(crate) fn analysis_diagnostics_dir() -> PathBuf {
    std::env::var_os("TUNEFORGE_ANALYSIS_DIAGNOSTICS_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .expect("analysis diagnostics require TUNEFORGE_ANALYSIS_DIAGNOSTICS_DIR")
}
