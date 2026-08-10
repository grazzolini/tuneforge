use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};

const JSON_FILTER_NAME: &str = "JSON";
const JSON_EXTENSION: &str = "json";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum JsonFilePathError {
    NonLocalFileSelection,
    WrongExtension,
    MissingReadTarget,
    ReadTargetSymlink,
    ReadTargetDirectory,
    ReadTargetNotFile,
    ReadTargetUnavailable,
    MissingParent,
    ParentSymlink,
    ParentNotDirectory,
    ParentUnavailable,
    DestinationSymlink,
    DestinationDirectory,
    DestinationNotFile,
    DestinationUnavailable,
}

impl JsonFilePathError {
    fn read_message(&self) -> &'static str {
        match self {
            Self::WrongExtension => "Selected settings file must be a JSON file.",
            Self::MissingReadTarget => "Selected settings file no longer exists.",
            Self::ReadTargetDirectory => "Selected settings file is a directory.",
            Self::ReadTargetSymlink | Self::ReadTargetNotFile | Self::NonLocalFileSelection => {
                "Selected settings file is not a supported local JSON file."
            }
            Self::ReadTargetUnavailable => "Selected settings file could not be checked.",
            Self::MissingParent
            | Self::ParentSymlink
            | Self::ParentNotDirectory
            | Self::ParentUnavailable
            | Self::DestinationSymlink
            | Self::DestinationDirectory
            | Self::DestinationNotFile
            | Self::DestinationUnavailable => "Selected settings file is not readable.",
        }
    }

    fn write_message(&self, purpose: &str) -> String {
        match self {
            Self::WrongExtension => format!("Selected {purpose} location must be a JSON file."),
            Self::MissingParent => {
                format!("Selected {purpose} folder no longer exists.")
            }
            Self::ParentSymlink | Self::ParentNotDirectory | Self::NonLocalFileSelection => {
                format!("Selected {purpose} folder is not a supported local folder.")
            }
            Self::DestinationSymlink | Self::DestinationDirectory | Self::DestinationNotFile => {
                format!("Selected {purpose} location is not safe to write.")
            }
            Self::ParentUnavailable | Self::DestinationUnavailable => {
                format!("Selected {purpose} location could not be checked.")
            }
            Self::MissingReadTarget
            | Self::ReadTargetSymlink
            | Self::ReadTargetDirectory
            | Self::ReadTargetNotFile
            | Self::ReadTargetUnavailable => {
                format!("Selected {purpose} location is not writable.")
            }
        }
    }
}

pub(crate) fn read_user_selected_json_file(
    app: &AppHandle,
    title: &str,
) -> Result<Option<String>, String> {
    let Some(path) = pick_user_selected_json_file(app, title)? else {
        return Ok(None);
    };
    validate_user_selected_json_read_path(&path).map_err(|error| error.read_message())?;
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read selected settings file: {error}"))?;
    Ok(Some(contents))
}

pub(crate) fn write_user_selected_json_file(
    app: &AppHandle,
    title: &str,
    default_file_name: String,
    fallback_file_name: &str,
    contents: String,
    purpose: &str,
) -> Result<bool, String> {
    validate_json_contents(&contents, purpose)?;
    let default_file_name = sanitized_json_file_name(&default_file_name, fallback_file_name);
    let Some(selection) = pick_user_selected_json_save_path(app, title, default_file_name)? else {
        return Ok(false);
    };
    validate_user_selected_json_write_selection(&selection)
        .map_err(|error| error.write_message(purpose))?;

    let write_target = selection.clone();
    let read_target = selection;
    let mut write_options = OpenOptions::new();
    write_options.write(true).truncate(true).create(true);
    persist_and_verify_json(
        &contents,
        purpose,
        || app.fs().open(write_target, write_options),
        || {
            let mut read_options = OpenOptions::new();
            read_options.read(true);
            let mut file = app.fs().open(read_target, read_options)?;
            let mut verified = String::new();
            file.read_to_string(&mut verified)?;
            Ok(verified)
        },
    )?;
    Ok(true)
}

// User-selected JSON snapshot/evidence files are the only allowed roots.
fn pick_user_selected_json_file(app: &AppHandle, title: &str) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(JSON_FILTER_NAME, &[JSON_EXTENSION])
        .blocking_pick_file()
        .map(selected_file_path_to_local_path)
        .transpose()
        .map_err(|error| error.read_message().to_string())
}

// Renderer supplies only a default name; native dialog supplies the destination.
fn pick_user_selected_json_save_path(
    app: &AppHandle,
    title: &str,
    default_file_name: String,
) -> Result<Option<FilePath>, String> {
    Ok(app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(default_file_name)
        .add_filter(JSON_FILTER_NAME, &[JSON_EXTENSION])
        .blocking_save_file())
}

fn selected_file_path_to_local_path(selection: FilePath) -> Result<PathBuf, JsonFilePathError> {
    let path = match selection {
        FilePath::Path(path) => path,
        FilePath::Url(url) if url.scheme() == "file" => url
            .to_file_path()
            .map_err(|_| JsonFilePathError::NonLocalFileSelection)?,
        FilePath::Url(_) => return Err(JsonFilePathError::NonLocalFileSelection),
    };

    if path.is_absolute() {
        Ok(path)
    } else {
        Err(JsonFilePathError::NonLocalFileSelection)
    }
}

fn validate_user_selected_json_write_selection(
    selection: &FilePath,
) -> Result<(), JsonFilePathError> {
    validate_user_selected_json_write_selection_for_platform(selection, cfg!(target_os = "android"))
}

fn validate_user_selected_json_write_selection_for_platform(
    selection: &FilePath,
    allow_android_content: bool,
) -> Result<(), JsonFilePathError> {
    match selection {
        FilePath::Url(url) if url.scheme() == "content" && allow_android_content => Ok(()),
        FilePath::Url(url) if url.scheme() != "file" => {
            Err(JsonFilePathError::NonLocalFileSelection)
        }
        _ => validate_user_selected_json_write_path(&selected_file_path_to_local_path(
            selection.clone(),
        )?),
    }
}

pub(crate) fn validate_user_selected_json_read_path(path: &Path) -> Result<(), JsonFilePathError> {
    validate_json_extension(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => JsonFilePathError::MissingReadTarget,
        _ => JsonFilePathError::ReadTargetUnavailable,
    })?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(JsonFilePathError::ReadTargetSymlink);
    }
    if file_type.is_dir() {
        return Err(JsonFilePathError::ReadTargetDirectory);
    }
    if !file_type.is_file() {
        return Err(JsonFilePathError::ReadTargetNotFile);
    }
    Ok(())
}

pub(crate) fn validate_user_selected_json_write_path(path: &Path) -> Result<(), JsonFilePathError> {
    validate_json_extension(path)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or(JsonFilePathError::MissingParent)?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => JsonFilePathError::MissingParent,
        _ => JsonFilePathError::ParentUnavailable,
    })?;
    let parent_type = parent_metadata.file_type();
    if parent_type.is_symlink() {
        return Err(JsonFilePathError::ParentSymlink);
    }
    if !parent_type.is_dir() {
        return Err(JsonFilePathError::ParentNotDirectory);
    }

    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                Err(JsonFilePathError::DestinationSymlink)
            } else if file_type.is_dir() {
                Err(JsonFilePathError::DestinationDirectory)
            } else if !file_type.is_file() {
                Err(JsonFilePathError::DestinationNotFile)
            } else {
                Ok(())
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(JsonFilePathError::DestinationUnavailable),
    }
}

fn validate_json_extension(path: &Path) -> Result<(), JsonFilePathError> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case(JSON_EXTENSION) => Ok(()),
        _ => Err(JsonFilePathError::WrongExtension),
    }
}

fn validate_json_contents(contents: &str, purpose: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(contents)
        .map(|_| ())
        .map_err(|_| format!("Selected {purpose} contents are not valid JSON."))
}

trait SyncWrite: Write {
    fn sync_all(&self) -> io::Result<()>;
}

impl SyncWrite for fs::File {
    fn sync_all(&self) -> io::Result<()> {
        fs::File::sync_all(self)
    }
}

fn persist_and_verify_json<W: SyncWrite>(
    contents: &str,
    purpose: &str,
    open_writer: impl FnOnce() -> io::Result<W>,
    read_back: impl FnOnce() -> io::Result<String>,
) -> Result<(), String> {
    let mut writer =
        open_writer().map_err(|_| format!("Could not write selected {purpose} file."))?;
    writer
        .write_all(contents.as_bytes())
        .map_err(|_| format!("Could not write selected {purpose} file."))?;
    writer
        .flush()
        .and_then(|_| writer.sync_all())
        .map_err(|_| format!("Could not finish writing selected {purpose} file."))?;
    drop(writer);

    let verified = read_back().map_err(|_| format!("Could not verify selected {purpose} file."))?;
    if verified.is_empty()
        || verified != contents
        || serde_json::from_str::<serde_json::Value>(&verified).is_err()
    {
        return Err(format!("Selected {purpose} file could not be verified."));
    }
    Ok(())
}

fn sanitized_json_file_name(default_file_name: &str, fallback_file_name: &str) -> String {
    let file_name = Path::new(default_file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback_file_name);

    if has_json_extension(Path::new(file_name)) {
        file_name.to_string()
    } else {
        format!("{file_name}.{JSON_EXTENSION}")
    }
}

fn has_json_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(JSON_EXTENSION))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, File},
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDir {
        root: PathBuf,
    }

    impl TestDir {
        fn new(test_name: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "tuneforge-file-dialog-scope-{test_name}-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("create temp test directory");
            Self { root }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[derive(Default)]
    struct TestWriter {
        fail_write: bool,
        fail_flush: bool,
        fail_sync: bool,
    }

    impl Write for TestWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.fail_write {
                Err(io::Error::other("private write detail"))
            } else {
                Ok(buffer.len())
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            if self.fail_flush {
                Err(io::Error::other("private flush detail"))
            } else {
                Ok(())
            }
        }
    }

    impl SyncWrite for TestWriter {
        fn sync_all(&self) -> io::Result<()> {
            if self.fail_sync {
                Err(io::Error::other("private sync detail"))
            } else {
                Ok(())
            }
        }
    }

    fn persist_test_json(
        contents: &str,
        writer: TestWriter,
        read_back: io::Result<String>,
    ) -> Result<(), String> {
        persist_and_verify_json(contents, "sync evidence", || Ok(writer), || read_back)
    }

    #[test]
    fn validate_read_accepts_json_file() {
        let dir = TestDir::new("read-accepts-json");
        let path = dir.path("settings.json");
        fs::write(&path, "{}").expect("write json fixture");

        assert_eq!(validate_user_selected_json_read_path(&path), Ok(()));
    }

    #[test]
    fn validate_read_rejects_wrong_extension() {
        let dir = TestDir::new("read-rejects-extension");
        let path = dir.path("settings.txt");
        fs::write(&path, "{}").expect("write fixture");

        assert_eq!(
            validate_user_selected_json_read_path(&path),
            Err(JsonFilePathError::WrongExtension)
        );
    }

    #[test]
    fn validate_read_rejects_missing_target() {
        let dir = TestDir::new("read-rejects-missing");
        let path = dir.path("missing.json");

        assert_eq!(
            validate_user_selected_json_read_path(&path),
            Err(JsonFilePathError::MissingReadTarget)
        );
    }

    #[test]
    fn validate_read_rejects_directory() {
        let dir = TestDir::new("read-rejects-directory");
        let path = dir.path("directory.json");
        fs::create_dir(&path).expect("create directory fixture");

        assert_eq!(
            validate_user_selected_json_read_path(&path),
            Err(JsonFilePathError::ReadTargetDirectory)
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_read_rejects_symlink() {
        let dir = TestDir::new("read-rejects-symlink");
        let target = dir.path("target.json");
        let symlink = dir.path("link.json");
        fs::write(&target, "{}").expect("write symlink target");
        std::os::unix::fs::symlink(&target, &symlink).expect("create symlink");

        assert_eq!(
            validate_user_selected_json_read_path(&symlink),
            Err(JsonFilePathError::ReadTargetSymlink)
        );
    }

    #[test]
    fn validate_write_accepts_new_json_file() {
        let dir = TestDir::new("write-accepts-json");
        let path = dir.path("settings.json");

        assert_eq!(validate_user_selected_json_write_path(&path), Ok(()));
    }

    #[test]
    fn validate_write_rejects_missing_parent() {
        let dir = TestDir::new("write-rejects-missing-parent");
        let path = dir.path("missing-parent").join("settings.json");

        assert_eq!(
            validate_user_selected_json_write_path(&path),
            Err(JsonFilePathError::MissingParent)
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_write_rejects_parent_symlink() {
        let dir = TestDir::new("write-rejects-parent-symlink");
        let target_parent = dir.path("target-parent");
        let symlink_parent = dir.path("linked-parent");
        fs::create_dir(&target_parent).expect("create parent target");
        std::os::unix::fs::symlink(&target_parent, &symlink_parent).expect("create parent symlink");
        let path = symlink_parent.join("settings.json");

        assert_eq!(
            validate_user_selected_json_write_path(&path),
            Err(JsonFilePathError::ParentSymlink)
        );
    }

    #[test]
    fn validate_write_rejects_directory_destination() {
        let dir = TestDir::new("write-rejects-directory");
        let path = dir.path("settings.json");
        fs::create_dir(&path).expect("create directory fixture");

        assert_eq!(
            validate_user_selected_json_write_path(&path),
            Err(JsonFilePathError::DestinationDirectory)
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_write_rejects_unsafe_existing_destination() {
        let dir = TestDir::new("write-rejects-symlink");
        let target = dir.path("target.json");
        let symlink = dir.path("link.json");
        fs::write(&target, "{}").expect("write symlink target");
        std::os::unix::fs::symlink(&target, &symlink).expect("create symlink");

        assert_eq!(
            validate_user_selected_json_write_path(&symlink),
            Err(JsonFilePathError::DestinationSymlink)
        );
    }

    #[test]
    fn validate_write_accepts_existing_json_file() {
        let dir = TestDir::new("write-accepts-existing-file");
        let path = dir.path("settings.json");
        File::create(&path).expect("create file fixture");

        assert_eq!(validate_user_selected_json_write_path(&path), Ok(()));
    }

    #[test]
    fn write_selection_accepts_content_uri_only_for_android_policy() {
        let selection = serde_json::from_str::<FilePath>(
            "\"content://com.example.documents/document/sync-evidence\"",
        )
        .expect("parse content URI");

        assert_eq!(
            validate_user_selected_json_write_selection_for_platform(&selection, true),
            Ok(())
        );
        assert_eq!(
            validate_user_selected_json_write_selection_for_platform(&selection, false),
            Err(JsonFilePathError::NonLocalFileSelection)
        );
    }

    #[test]
    fn write_selection_rejects_other_remote_schemes() {
        let selection = serde_json::from_str::<FilePath>("\"https://example.test/evidence.json\"")
            .expect("parse remote URL");

        assert_eq!(
            validate_user_selected_json_write_selection_for_platform(&selection, true),
            Err(JsonFilePathError::NonLocalFileSelection)
        );
    }

    #[test]
    fn persistence_requires_exact_valid_readback() {
        let contents = "{\"privacySafe\":true}";

        assert_eq!(
            persist_test_json(contents, TestWriter::default(), Ok(contents.to_string())),
            Ok(())
        );
    }

    #[test]
    fn persistence_rejects_write_failure_without_private_detail() {
        let result = persist_test_json(
            "{}",
            TestWriter {
                fail_write: true,
                ..Default::default()
            },
            Ok("{}".to_string()),
        );

        assert_eq!(
            result,
            Err("Could not write selected sync evidence file.".to_string())
        );
    }

    #[test]
    fn persistence_rejects_flush_and_sync_failures() {
        let flush_result = persist_test_json(
            "{}",
            TestWriter {
                fail_flush: true,
                ..Default::default()
            },
            Ok("{}".to_string()),
        );
        let sync_result = persist_test_json(
            "{}",
            TestWriter {
                fail_sync: true,
                ..Default::default()
            },
            Ok("{}".to_string()),
        );

        let expected = Err("Could not finish writing selected sync evidence file.".to_string());
        assert_eq!(flush_result, expected);
        assert_eq!(sync_result, expected);
    }

    #[test]
    fn persistence_rejects_reopen_failure_without_private_detail() {
        let result = persist_test_json(
            "{}",
            TestWriter::default(),
            Err(io::Error::other("private provider detail")),
        );

        assert_eq!(
            result,
            Err("Could not verify selected sync evidence file.".to_string())
        );
    }

    #[test]
    fn persistence_rejects_empty_malformed_and_mismatched_readback() {
        let expected = Err("Selected sync evidence file could not be verified.".to_string());

        assert_eq!(
            persist_test_json("{}", TestWriter::default(), Ok(String::new())),
            expected
        );
        assert_eq!(
            persist_test_json("{}", TestWriter::default(), Ok("not json".to_string())),
            expected
        );
        assert_eq!(
            persist_test_json(
                "{}",
                TestWriter::default(),
                Ok("{\"other\":true}".to_string())
            ),
            expected
        );
    }
}
