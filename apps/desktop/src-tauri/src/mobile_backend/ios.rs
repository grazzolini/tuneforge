include!("embedded.rs");

fn spawn_playback_proxy_generation(
    _root: PathBuf,
    _project_root: PathBuf,
    _source_path: PathBuf,
    _artifact_id: String,
) {
}

fn ensure_source_playback_proxy_metadata(
    _connection: &Connection,
    _root: &Path,
    _project_id: &str,
) -> Result<(), String> {
    Ok(())
}
