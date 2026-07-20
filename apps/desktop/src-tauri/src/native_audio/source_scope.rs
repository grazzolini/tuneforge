use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(any(target_os = "linux", target_os = "macos", test))]
use std::{env, ffi::OsStr};

use rusqlite::{params, Connection, Error as SqliteError, OpenFlags, OptionalExtension};
use serde_json::Value;
#[cfg(not(target_os = "android"))]
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::{AppHandle, Manager};

#[cfg(any(target_os = "linux", target_os = "macos", test))]
const BACKEND_DATABASE_NAME: &str = "app.sqlite";
#[cfg(target_os = "android")]
const MOBILE_DATABASE_NAME: &str = "mobile.sqlite3";
const BACKEND_PROJECTS_DIR: &str = "projects";
const PLAYBACK_SOURCE_MISSING_MESSAGE: &str = "Native playback source is missing or unavailable.";
const PLAYBACK_SOURCE_UNAVAILABLE_MESSAGE: &str =
    "Native playback source is unavailable for native playback.";
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(any(target_os = "linux", target_os = "macos", test))]
const TUNEFORGE_DATA_DIR: &str = "TUNEFORGE_DATA_DIR";

pub(super) struct PlaybackSourceScope {
    database_path: PathBuf,
    projects_root: PathBuf,
}

impl PlaybackSourceScope {
    pub(super) fn from_app(app: &AppHandle) -> Result<Self, String> {
        #[cfg(target_os = "android")]
        {
            let data_root = app
                .path()
                .app_data_dir()
                .map_err(|_| PLAYBACK_SOURCE_UNAVAILABLE_MESSAGE.to_string())?;
            return Self::from_data_root(&data_root, MOBILE_DATABASE_NAME)
                .map_err(|error| error.message().to_string());
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Self::from_backend_config()
        }
    }

    #[cfg(not(target_os = "android"))]
    pub(super) fn from_backend_config() -> Result<Self, String> {
        let data_root = backend_data_root()?;
        Self::from_backend_data_root(&data_root).map_err(|error| error.message().to_string())
    }

    #[cfg(any(target_os = "linux", target_os = "macos", test))]
    fn from_backend_data_root(data_root: &Path) -> Result<Self, PlaybackSourceError> {
        Self::from_data_root(data_root, BACKEND_DATABASE_NAME)
    }

    fn from_data_root(data_root: &Path, database_name: &str) -> Result<Self, PlaybackSourceError> {
        let database_path = data_root.join(database_name);
        let projects_root = data_root.join(BACKEND_PROJECTS_DIR);
        let metadata =
            fs::metadata(&projects_root).map_err(|_| PlaybackSourceError::Unavailable)?;
        if !metadata.is_dir() {
            return Err(PlaybackSourceError::Unavailable);
        }
        let projects_root = projects_root
            .canonicalize()
            .map_err(|_| PlaybackSourceError::Unavailable)?;
        Ok(Self {
            database_path,
            projects_root,
        })
    }

    pub(super) fn validate(
        &self,
        artifact_id: Option<&str>,
        source_path: &str,
    ) -> Result<PathBuf, PlaybackSourceError> {
        let artifact_id = artifact_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(PlaybackSourceError::Unavailable)?;
        let canonical_path = validate_playback_source_path(source_path, &self.projects_root)?;
        let artifact_paths = artifact_paths_for_id(&self.database_path, artifact_id)?;
        let matches_registered_path = artifact_paths.iter().any(|artifact_path| {
            validate_artifact_record_path(artifact_path, &self.projects_root)
                .is_ok_and(|registered_path| registered_path == canonical_path)
        });
        if !matches_registered_path {
            return Err(PlaybackSourceError::Unavailable);
        }
        Ok(canonical_path)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PlaybackSourceError {
    Missing,
    Unavailable,
}

impl PlaybackSourceError {
    pub(super) fn message(self) -> &'static str {
        match self {
            Self::Missing => PLAYBACK_SOURCE_MISSING_MESSAGE,
            Self::Unavailable => PLAYBACK_SOURCE_UNAVAILABLE_MESSAGE,
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn backend_data_root() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let cwd = env::current_dir().unwrap_or_else(|_| home.clone());
    Ok(backend_data_root_from_parts(
        env::var_os(TUNEFORGE_DATA_DIR).as_deref(),
        &home,
        &cwd,
        BackendPlatform::current(),
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn home_dir() -> Result<PathBuf, String> {
    env::var("HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| PLAYBACK_SOURCE_UNAVAILABLE_MESSAGE.to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn backend_data_root_from_parts(
    override_dir: Option<&OsStr>,
    home: &Path,
    cwd: &Path,
    platform: BackendPlatform,
) -> PathBuf {
    if let Some(value) = override_dir.filter(|value| !value.is_empty()) {
        return absolute_path(&expand_home(Path::new(value), home), cwd);
    }
    default_backend_data_root(home, platform)
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn default_backend_data_root(home: &Path, platform: BackendPlatform) -> PathBuf {
    match platform {
        #[cfg(any(target_os = "macos", test))]
        BackendPlatform::Macos => home
            .join("Library")
            .join("Application Support")
            .join("Tuneforge"),
        #[cfg(any(target_os = "linux", test))]
        BackendPlatform::Linux => home.join(".local").join("share").join("tuneforge"),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn expand_home(path: &Path, home: &Path) -> PathBuf {
    let value = path.as_os_str().to_string_lossy();
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.join(rest);
    }
    path.to_path_buf()
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn absolute_path(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn validate_playback_source_path(
    source_path: &str,
    canonical_projects_root: &Path,
) -> Result<PathBuf, PlaybackSourceError> {
    let path = PathBuf::from(source_path);
    if !path.is_absolute() {
        return Err(PlaybackSourceError::Unavailable);
    }

    let metadata = fs::symlink_metadata(&path).map_err(|_| PlaybackSourceError::Missing)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlaybackSourceError::Unavailable);
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|_| PlaybackSourceError::Missing)?;
    if !canonical_path.starts_with(canonical_projects_root) {
        return Err(PlaybackSourceError::Unavailable);
    }

    Ok(canonical_path)
}

fn artifact_paths_for_id(
    database_path: &Path,
    artifact_id: &str,
) -> Result<Vec<PathBuf>, PlaybackSourceError> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| PlaybackSourceError::Unavailable)?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|_| PlaybackSourceError::Unavailable)?;
    let artifact = connection
        .query_row(
            "SELECT path, metadata_json FROM artifacts WHERE id = ?1",
            params![artifact_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| match error {
            SqliteError::QueryReturnedNoRows => PlaybackSourceError::Unavailable,
            _ => PlaybackSourceError::Unavailable,
        })?;
    let (artifact_path, metadata_json) = artifact.ok_or(PlaybackSourceError::Unavailable)?;
    let mut paths = Vec::with_capacity(2);
    if !artifact_path.trim().is_empty() {
        paths.push(PathBuf::from(artifact_path));
    }
    if let Some(playback_path) =
        serde_json::from_str::<Value>(&metadata_json)
            .ok()
            .and_then(|metadata| {
                metadata
                    .get("playback_path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
    {
        paths.push(playback_path);
    }
    if paths.is_empty() {
        return Err(PlaybackSourceError::Unavailable);
    }
    Ok(paths)
}

fn validate_artifact_record_path(
    artifact_path: &Path,
    canonical_projects_root: &Path,
) -> Result<PathBuf, PlaybackSourceError> {
    if !artifact_path.is_absolute() {
        return Err(PlaybackSourceError::Unavailable);
    }

    let metadata =
        fs::symlink_metadata(artifact_path).map_err(|_| PlaybackSourceError::Unavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlaybackSourceError::Unavailable);
    }

    let canonical_artifact_path = artifact_path
        .canonicalize()
        .map_err(|_| PlaybackSourceError::Unavailable)?;
    if !canonical_artifact_path.starts_with(canonical_projects_root) {
        return Err(PlaybackSourceError::Unavailable);
    }

    Ok(canonical_artifact_path)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(any(target_os = "linux", target_os = "macos", test))]
enum BackendPlatform {
    #[cfg(any(target_os = "macos", test))]
    Macos,
    #[cfg(any(target_os = "linux", test))]
    Linux,
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
impl BackendPlatform {
    fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(target_os = "linux")]
        {
            Self::Linux
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "tuneforge-native-audio-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn test_source_scope(temp: &TestTempDir) -> (PlaybackSourceScope, PathBuf) {
        let data_root = temp.path.join("backend-data");
        let projects_root = data_root.join(BACKEND_PROJECTS_DIR);
        fs::create_dir_all(&projects_root).expect("create projects root");
        create_artifacts_database(&data_root);
        (
            PlaybackSourceScope::from_backend_data_root(&data_root).expect("source scope"),
            projects_root,
        )
    }

    fn create_artifacts_database(data_root: &Path) {
        fs::create_dir_all(data_root).expect("create data root");
        let connection =
            Connection::open(data_root.join(BACKEND_DATABASE_NAME)).expect("open test database");
        connection
            .execute(
                "CREATE TABLE artifacts (id TEXT PRIMARY KEY, path TEXT NOT NULL, metadata_json TEXT NOT NULL)",
                [],
            )
            .expect("create artifacts table");
    }

    fn register_artifact(data_root: &Path, artifact_id: &str, path: &Path) {
        let connection =
            Connection::open(data_root.join(BACKEND_DATABASE_NAME)).expect("open test database");
        connection
            .execute(
                "INSERT INTO artifacts (id, path, metadata_json) VALUES (?1, ?2, '{}')",
                params![artifact_id, source_path_string(path)],
            )
            .expect("insert artifact");
    }

    fn register_artifact_with_playback_path(
        data_root: &Path,
        artifact_id: &str,
        path: &Path,
        playback_path: &Path,
    ) {
        let connection =
            Connection::open(data_root.join(BACKEND_DATABASE_NAME)).expect("open test database");
        let metadata = serde_json::json!({"playback_path": source_path_string(playback_path)});
        connection
            .execute(
                "INSERT INTO artifacts (id, path, metadata_json) VALUES (?1, ?2, ?3)",
                params![artifact_id, source_path_string(path), metadata.to_string()],
            )
            .expect("insert artifact");
    }

    fn data_root_for_scope(projects_root: &Path) -> &Path {
        projects_root.parent().expect("data root")
    }

    fn source_path_string(path: &Path) -> String {
        path.to_str().expect("utf-8 test path").to_string()
    }

    #[test]
    fn backend_data_root_default_matches_python_macos() {
        let home = PathBuf::from("/Users/example");
        let cwd = PathBuf::from("/work");

        let root = backend_data_root_from_parts(None, &home, &cwd, BackendPlatform::Macos);

        assert_eq!(
            root,
            PathBuf::from("/Users/example/Library/Application Support/Tuneforge")
        );
    }

    #[test]
    fn backend_data_root_default_matches_python_linux() {
        let home = PathBuf::from("/home/example");
        let cwd = PathBuf::from("/work");

        let root = backend_data_root_from_parts(None, &home, &cwd, BackendPlatform::Linux);

        assert_eq!(root, PathBuf::from("/home/example/.local/share/tuneforge"));
    }

    #[test]
    fn backend_data_root_uses_tuneforge_data_dir_override() {
        let home = PathBuf::from("/Users/example");
        let cwd = PathBuf::from("/work");

        let root = backend_data_root_from_parts(
            Some(OsStr::new("~/TuneForgeData")),
            &home,
            &cwd,
            BackendPlatform::Macos,
        );

        assert_eq!(root, PathBuf::from("/Users/example/TuneForgeData"));
    }

    #[test]
    fn backend_data_root_absolutizes_relative_override() {
        let home = PathBuf::from("/Users/example");
        let cwd = PathBuf::from("/work");

        let root = backend_data_root_from_parts(
            Some(OsStr::new("tmp/tuneforge")),
            &home,
            &cwd,
            BackendPlatform::Macos,
        );

        assert_eq!(root, PathBuf::from("/work/tmp/tuneforge"));
    }

    #[test]
    fn playback_source_scope_allows_backend_project_artifact_record_path() {
        let temp = TestTempDir::new("allowed");
        let (scope, projects_root) = test_source_scope(&temp);
        let source_dir = projects_root.join("project_123").join("source");
        fs::create_dir_all(&source_dir).expect("create source dir");
        let source_path = source_dir.join("source.wav");
        fs::write(&source_path, b"data").expect("write source");
        register_artifact(
            data_root_for_scope(&projects_root),
            "artifact_1",
            &source_path,
        );

        let validated = scope
            .validate(Some("artifact_1"), &source_path_string(&source_path))
            .expect("validate source");

        assert_eq!(
            validated,
            source_path.canonicalize().expect("canonical file")
        );
    }

    #[test]
    fn playback_source_scope_allows_registered_playback_proxy_path() {
        let temp = TestTempDir::new("playback-proxy");
        let (scope, projects_root) = test_source_scope(&temp);
        let source_dir = projects_root.join("project_123").join("source");
        fs::create_dir_all(&source_dir).expect("create source dir");
        let source_path = source_dir.join("source.flac");
        let playback_path = source_dir.join("source-playback.wav");
        fs::write(&source_path, b"source").expect("write source");
        fs::write(&playback_path, b"playback").expect("write playback proxy");
        register_artifact_with_playback_path(
            data_root_for_scope(&projects_root),
            "artifact_1",
            &source_path,
            &playback_path,
        );

        let validated = scope
            .validate(Some("artifact_1"), &source_path_string(&playback_path))
            .expect("validate playback proxy");

        assert_eq!(
            validated,
            playback_path.canonicalize().expect("canonical file")
        );
    }

    #[test]
    fn playback_source_scope_rejects_project_file_without_matching_artifact() {
        let temp = TestTempDir::new("unregistered");
        let (scope, projects_root) = test_source_scope(&temp);
        let project_dir = projects_root.join("project_123");
        fs::create_dir_all(&project_dir).expect("create project dir");
        let registered_path = project_dir.join("registered.wav");
        let unregistered_path = project_dir.join("unregistered.wav");
        fs::write(&registered_path, b"registered").expect("write registered");
        fs::write(&unregistered_path, b"unregistered").expect("write unregistered");
        register_artifact(
            data_root_for_scope(&projects_root),
            "artifact_1",
            &registered_path,
        );

        let error = scope
            .validate(Some("artifact_1"), &source_path_string(&unregistered_path))
            .expect_err("reject unregistered source");

        assert_eq!(error, PlaybackSourceError::Unavailable);
        assert!(!error
            .message()
            .contains(unregistered_path.to_str().expect("path")));
    }

    #[test]
    fn playback_source_scope_rejects_missing_artifact_id() {
        let temp = TestTempDir::new("missing-artifact-id");
        let (scope, projects_root) = test_source_scope(&temp);
        let source_dir = projects_root.join("project_123").join("source");
        fs::create_dir_all(&source_dir).expect("create source dir");
        let source_path = source_dir.join("source.wav");
        fs::write(&source_path, b"data").expect("write source");
        register_artifact(
            data_root_for_scope(&projects_root),
            "artifact_1",
            &source_path,
        );

        let error = scope
            .validate(None, &source_path_string(&source_path))
            .expect_err("reject source without artifact id");

        assert_eq!(error, PlaybackSourceError::Unavailable);
        assert!(!error
            .message()
            .contains(source_path.to_str().expect("path")));
    }

    #[test]
    fn playback_source_scope_rejects_wrong_artifact_id_path() {
        let temp = TestTempDir::new("wrong-artifact-id");
        let (scope, projects_root) = test_source_scope(&temp);
        let project_dir = projects_root.join("project_123");
        fs::create_dir_all(&project_dir).expect("create project dir");
        let requested_path = project_dir.join("requested.wav");
        let other_path = project_dir.join("other.wav");
        fs::write(&requested_path, b"requested").expect("write requested");
        fs::write(&other_path, b"other").expect("write other");
        register_artifact(
            data_root_for_scope(&projects_root),
            "requested_artifact",
            &requested_path,
        );
        register_artifact(
            data_root_for_scope(&projects_root),
            "other_artifact",
            &other_path,
        );

        let error = scope
            .validate(Some("other_artifact"), &source_path_string(&requested_path))
            .expect_err("reject wrong artifact id");

        assert_eq!(error, PlaybackSourceError::Unavailable);
        assert!(!error
            .message()
            .contains(requested_path.to_str().expect("path")));
    }

    #[test]
    fn playback_source_scope_rejects_out_of_scope_file() {
        let temp = TestTempDir::new("out-of-scope");
        let (scope, _) = test_source_scope(&temp);
        let outside_path = temp.path.join("outside.wav");
        fs::write(&outside_path, b"data").expect("write outside");

        let error = scope
            .validate(Some("artifact_1"), &source_path_string(&outside_path))
            .expect_err("reject outside file");

        assert_eq!(error, PlaybackSourceError::Unavailable);
        assert!(!error
            .message()
            .contains(outside_path.to_str().expect("path")));
    }

    #[test]
    fn playback_source_scope_rejects_symlink_escape() {
        let temp = TestTempDir::new("symlink");
        let (scope, projects_root) = test_source_scope(&temp);
        let outside_path = temp.path.join("outside.wav");
        fs::write(&outside_path, b"data").expect("write outside");
        let source_dir = projects_root.join("project_123").join("source");
        fs::create_dir_all(&source_dir).expect("create source dir");
        let symlink_path = source_dir.join("source.wav");
        std::os::unix::fs::symlink(&outside_path, &symlink_path).expect("create symlink");

        let error = scope
            .validate(Some("artifact_1"), &source_path_string(&symlink_path))
            .expect_err("reject symlink");

        assert_eq!(error, PlaybackSourceError::Unavailable);
        assert!(!error
            .message()
            .contains(symlink_path.to_str().expect("path")));
    }

    #[test]
    fn playback_source_scope_reports_missing_project_file() {
        let temp = TestTempDir::new("missing");
        let (scope, projects_root) = test_source_scope(&temp);
        let source_path = projects_root
            .join("project_123")
            .join("source")
            .join("missing.wav");

        let error = scope
            .validate(Some("artifact_1"), &source_path_string(&source_path))
            .expect_err("reject missing file");

        assert_eq!(error, PlaybackSourceError::Missing);
        assert!(!error
            .message()
            .contains(source_path.to_str().expect("path")));
    }

    #[test]
    fn playback_source_scope_rejects_directory() {
        let temp = TestTempDir::new("directory");
        let (scope, projects_root) = test_source_scope(&temp);
        let source_dir = projects_root.join("project_123").join("source");
        fs::create_dir_all(&source_dir).expect("create source dir");

        let error = scope
            .validate(Some("artifact_1"), &source_path_string(&source_dir))
            .expect_err("reject directory");

        assert_eq!(error, PlaybackSourceError::Unavailable);
        assert!(!error.message().contains(source_dir.to_str().expect("path")));
    }
}
