use super::*;
use std::path::Component;
use std::sync::{Mutex, MutexGuard, OnceLock};

static FAILED_PROJECTS: OnceLock<Mutex<HashMap<PathBuf, HashSet<String>>>> = OnceLock::new();
static STORAGE_MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct EntryIdentity {
    pub(super) kind: EntryKind,
    #[cfg(unix)]
    pub(super) device: u64,
    #[cfg(unix)]
    pub(super) inode: u64,
    #[cfg(not(unix))]
    pub(super) length: u64,
    #[cfg(not(unix))]
    pub(super) modified: Option<std::time::SystemTime>,
}

#[derive(Debug)]
struct ProjectStoragePlan {
    data_root: PathBuf,
    projects_root: PathBuf,
    project_root: PathBuf,
    protected_paths: HashSet<PathBuf>,
    delete_project_root: bool,
}

pub(super) struct OwnedProjectFile {
    data_root: PathBuf,
    project_root: PathBuf,
    path: PathBuf,
    identity: EntryIdentity,
}

pub(super) fn project_storage_mutation_guard() -> MutexGuard<'static, ()> {
    STORAGE_MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn reconcile_project_storage_after_commit(
    connection: &Connection,
    root: &Path,
    project_id: &str,
) {
    let _storage_guard = project_storage_mutation_guard();
    let root_key = lexical_absolute(root).unwrap_or_else(|_| root.to_path_buf());
    let failed_projects = FAILED_PROJECTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut project_ids = failed_projects
        .lock()
        .ok()
        .and_then(|mut failed| failed.remove(&root_key))
        .unwrap_or_default();
    project_ids.insert(project_id.to_string());

    let mut retry = HashSet::new();
    for project_id in project_ids {
        if reconcile_project_storage(connection, root, &project_id).is_err() {
            retry.insert(project_id);
        }
    }
    if !retry.is_empty() {
        if let Ok(mut failed) = failed_projects.lock() {
            failed.entry(root_key).or_default().extend(retry);
        }
    }
}

pub(super) fn prepare_owned_project_file(
    root: &Path,
    project_root: &Path,
    path: &Path,
) -> Result<PathBuf, String> {
    let data_root = lexical_absolute(root)?;
    let projects_root = lexical_absolute(&data_root.join("projects"))?;
    let project_root = lexical_absolute(project_root)?;
    let path = lexical_absolute(path)?;
    if project_root.parent() != Some(projects_root.as_path())
        || !projects_root.starts_with(&data_root)
        || !path.starts_with(&project_root)
        || path == project_root
    {
        return Err("Mobile project destination escapes app storage.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Mobile project destination has no safe parent.".to_string())?;
    ensure_owned_directory(&data_root, parent)?;
    match path_identity(&path)? {
        None
        | Some(EntryIdentity {
            kind: EntryKind::File,
            ..
        }) => Ok(path),
        _ => Err("Mobile project destination is not a safe file.".to_string()),
    }
}

pub(super) fn capture_owned_project_file(
    root: &Path,
    project_root: &Path,
    path: &Path,
) -> Result<OwnedProjectFile, String> {
    let path = prepare_owned_project_file(root, project_root, path)?;
    let identity = path_identity(&path)?
        .filter(|identity| identity.kind == EntryKind::File)
        .ok_or_else(|| "Mobile project file is unavailable.".to_string())?;
    Ok(OwnedProjectFile {
        data_root: lexical_absolute(root)?,
        project_root: lexical_absolute(project_root)?,
        path,
        identity,
    })
}

pub(super) fn move_owned_project_file(
    source: &OwnedProjectFile,
    destination: &Path,
) -> Result<OwnedProjectFile, String> {
    require_owned_project_file(source)?;
    let destination =
        prepare_owned_project_file(&source.data_root, &source.project_root, destination)?;
    fs::rename(&source.path, &destination).map_err(|error| error.to_string())?;
    capture_owned_project_file(&source.data_root, &source.project_root, &destination)
}

pub(super) fn cleanup_owned_project_files(files: &[OwnedProjectFile]) {
    for file in files {
        if require_owned_project_file(file).is_ok() {
            let _ = fs::remove_file(&file.path);
        }
    }
}

pub(super) fn require_owned_project_file(file: &OwnedProjectFile) -> Result<(), String> {
    let path = prepare_owned_project_file(&file.data_root, &file.project_root, &file.path)?;
    if path_identity(&path)?.as_ref() != Some(&file.identity) {
        return Err("Mobile project file changed before mutation.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Mobile project file has no safe parent.".to_string())?;
    let parent_identity = path_identity(parent)?
        .ok_or_else(|| "Mobile project file parent is unavailable.".to_string())?;
    require_stable_directory(parent, &parent_identity)
}

pub(super) fn ensure_owned_directory(data_root: &Path, directory: &Path) -> Result<(), String> {
    let data_root = lexical_absolute(data_root)?;
    let directory = lexical_absolute(directory)?;
    let relative = directory
        .strip_prefix(&data_root)
        .map_err(|_| "Mobile project directory escapes app storage.".to_string())?;
    let mut parent = data_root;
    let mut parent_identity = path_identity(&parent)?
        .filter(|identity| identity.kind == EntryKind::Directory)
        .ok_or_else(|| "Mobile app data root is not a safe directory.".to_string())?;
    for component in relative.components() {
        require_stable_directory(&parent, &parent_identity)?;
        let child = parent.join(component.as_os_str());
        if path_identity(&child)?.is_none() {
            match fs::create_dir(&child) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        require_stable_directory(&parent, &parent_identity)?;
        let child_identity = path_identity(&child)?
            .filter(|identity| identity.kind == EntryKind::Directory)
            .ok_or_else(|| "Mobile project directory is not safe.".to_string())?;
        require_stable_directory(&child, &child_identity)?;
        parent = child;
        parent_identity = child_identity;
    }
    Ok(())
}

pub(super) fn reconcile_project_storage(
    connection: &Connection,
    root: &Path,
    project_id: &str,
) -> Result<(), String> {
    let plan = build_project_storage_plan(connection, root, project_id)?;
    let Some(projects_identity) = validate_storage_roots(&plan)? else {
        return Ok(());
    };
    let Some(project_identity) = path_identity(&plan.project_root)? else {
        return Ok(());
    };

    require_stable_directory(&plan.projects_root, &projects_identity)?;
    match project_identity.kind {
        EntryKind::Symlink if plan.protected_paths.is_empty() => unlink_entry(
            &plan.projects_root,
            &projects_identity,
            &plan.project_root,
            &project_identity,
        ),
        EntryKind::Symlink => {
            Err("Mobile project root is a symlink with live storage references.".to_string())
        }
        EntryKind::Directory => {
            reconcile_directory(
                &plan.project_root,
                &project_identity,
                Path::new(""),
                &plan.protected_paths,
            )?;
            if plan.delete_project_root && plan.protected_paths.is_empty() {
                remove_directory(
                    &plan.projects_root,
                    &projects_identity,
                    &plan.project_root,
                    &project_identity,
                )?;
            }
            Ok(())
        }
        _ => Err("Mobile project root is not a directory.".to_string()),
    }
}

fn build_project_storage_plan(
    connection: &Connection,
    root: &Path,
    project_id: &str,
) -> Result<ProjectStoragePlan, String> {
    let data_root = lexical_absolute(root)?;
    let projects_root = lexical_absolute(&data_root.join("projects"))?;
    let project_root = lexical_absolute(&project_cleanup_root_path(&data_root, project_id)?)?;
    if !projects_root.starts_with(&data_root) || !project_root.starts_with(&projects_root) {
        return Err("Mobile project cleanup path escapes app storage.".to_string());
    }

    let delete_project_root = connection
        .query_row(
            "SELECT sync_status FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_none_or(|status| status == "deleted");
    let mut protected_paths = HashSet::new();

    let mut projects = connection
        .prepare("SELECT source_path, imported_path FROM projects WHERE sync_status != 'deleted'")
        .map_err(|error| error.to_string())?;
    let project_rows = projects
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in project_rows {
        let (source_path, imported_path) = row.map_err(|error| error.to_string())?;
        protect_owned_path(&mut protected_paths, &project_root, Path::new(&source_path))?;
        protect_owned_path(
            &mut protected_paths,
            &project_root,
            Path::new(&imported_path),
        )?;
    }

    let mut artifacts = connection
        .prepare(
            "SELECT artifacts.path, artifacts.metadata_json
             FROM artifacts
             LEFT JOIN projects ON projects.id = artifacts.project_id
             WHERE projects.id IS NULL OR projects.sync_status != 'deleted'",
        )
        .map_err(|error| error.to_string())?;
    let artifact_rows = artifacts
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in artifact_rows {
        let (artifact_path, metadata_json) = row.map_err(|error| error.to_string())?;
        protect_owned_path(
            &mut protected_paths,
            &project_root,
            Path::new(&artifact_path),
        )?;
        let metadata = serde_json::from_str::<Value>(&metadata_json).map_err(|_| {
            "Mobile artifact storage metadata is unreadable; cleanup deferred.".to_string()
        })?;
        protect_metadata_paths(&mut protected_paths, &project_root, &metadata)?;
    }

    if !delete_project_root {
        for (table, snapshot) in [
            ("analysis_results", "analysis/analysis.json"),
            ("chord_timelines", "analysis/chords.json"),
            ("lyrics_transcripts", "analysis/lyrics.json"),
        ] {
            let exists = connection
                .query_row(
                    &format!("SELECT 1 FROM {table} WHERE project_id = ?1 LIMIT 1"),
                    params![project_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .is_some();
            if exists {
                protect_relative_path(&mut protected_paths, Path::new(snapshot));
            }
        }
    }

    Ok(ProjectStoragePlan {
        data_root,
        projects_root,
        project_root,
        protected_paths,
        delete_project_root,
    })
}

fn protect_metadata_paths(
    protected: &mut HashSet<PathBuf>,
    project_root: &Path,
    value: &Value,
) -> Result<(), String> {
    match value {
        Value::String(value) => protect_owned_path(protected, project_root, Path::new(value)),
        Value::Array(values) => {
            for value in values {
                protect_metadata_paths(protected, project_root, value)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for value in values.values() {
                protect_metadata_paths(protected, project_root, value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn protect_owned_path(
    protected: &mut HashSet<PathBuf>,
    project_root: &Path,
    path: &Path,
) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    let path = lexical_absolute(path)?;
    if let Ok(relative) = path.strip_prefix(project_root) {
        if !relative.as_os_str().is_empty() {
            protect_relative_path(protected, relative);
        }
    }
    Ok(())
}

fn protect_relative_path(protected: &mut HashSet<PathBuf>, relative: &Path) {
    let mut prefix = PathBuf::new();
    for part in relative.components() {
        prefix.push(part.as_os_str());
        protected.insert(prefix.clone());
    }
}

fn validate_storage_roots(plan: &ProjectStoragePlan) -> Result<Option<EntryIdentity>, String> {
    if !plan.projects_root.starts_with(&plan.data_root)
        || !plan.project_root.starts_with(&plan.projects_root)
    {
        return Err("Mobile project cleanup path escapes app storage.".to_string());
    }
    let data_identity = path_identity(&plan.data_root)?
        .ok_or_else(|| "Mobile app data root is unavailable.".to_string())?;
    if data_identity.kind != EntryKind::Directory {
        return Err("Mobile app data root is not a safe directory.".to_string());
    }
    require_stable_directory(&plan.data_root, &data_identity)?;
    let Some(projects_identity) = path_identity(&plan.projects_root)? else {
        return Ok(None);
    };
    if projects_identity.kind != EntryKind::Directory {
        return Err("Mobile projects root is not a safe directory.".to_string());
    }
    require_stable_directory(&plan.data_root, &data_identity)?;
    Ok(Some(projects_identity))
}

fn reconcile_directory(
    directory: &Path,
    directory_identity: &EntryIdentity,
    relative_root: &Path,
    protected: &HashSet<PathBuf>,
) -> Result<(), String> {
    require_stable_directory(directory, directory_identity)?;
    let entries = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    require_stable_directory(directory, directory_identity)?;

    for entry in entries {
        let child = directory.join(entry.file_name());
        let relative = relative_root.join(entry.file_name());
        let Some(child_identity) = path_identity(&child)? else {
            continue;
        };
        match child_identity.kind {
            EntryKind::Directory => {
                reconcile_directory(&child, &child_identity, &relative, protected)?;
                if !protected.contains(&relative) {
                    remove_directory(directory, directory_identity, &child, &child_identity)?;
                }
            }
            EntryKind::File | EntryKind::Symlink if !protected.contains(&relative) => {
                unlink_entry(directory, directory_identity, &child, &child_identity)?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn unlink_entry(
    parent: &Path,
    parent_identity: &EntryIdentity,
    path: &Path,
    expected: &EntryIdentity,
) -> Result<(), String> {
    require_stable_directory(parent, parent_identity)?;
    let Some(current) = path_identity(path)? else {
        return Ok(());
    };
    if current != *expected {
        return Err("Mobile storage entry changed before cleanup.".to_string());
    }
    fs::remove_file(path).map_err(|error| error.to_string())
}

fn remove_directory(
    parent: &Path,
    parent_identity: &EntryIdentity,
    path: &Path,
    expected: &EntryIdentity,
) -> Result<(), String> {
    require_stable_directory(parent, parent_identity)?;
    let Some(current) = path_identity(path)? else {
        return Ok(());
    };
    if current != *expected || current.kind != EntryKind::Directory {
        return Err("Mobile storage directory changed before cleanup.".to_string());
    }
    fs::remove_dir(path).map_err(|error| error.to_string())
}

pub(super) fn require_stable_directory(
    path: &Path,
    expected: &EntryIdentity,
) -> Result<(), String> {
    let current = path_identity(path)?;
    if current.as_ref() != Some(expected) || expected.kind != EntryKind::Directory {
        return Err("Mobile storage parent changed before cleanup.".to_string());
    }
    Ok(())
}

pub(super) fn path_identity(path: &Path) -> Result<Option<EntryIdentity>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        EntryKind::Symlink
    } else if file_type.is_dir() {
        EntryKind::Directory
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(EntryIdentity {
            kind,
            device: metadata.dev(),
            inode: metadata.ino(),
        }))
    }
    #[cfg(not(unix))]
    {
        Ok(Some(EntryIdentity {
            kind,
            length: metadata.len(),
            modified: metadata.modified().ok(),
        }))
    }
}

pub(super) fn lexical_absolute(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("Mobile storage path cannot be normalized safely.".to_string());
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot {
        parent: PathBuf,
        data: PathBuf,
    }

    impl TestRoot {
        fn new(label: &str) -> Self {
            let parent = std::env::temp_dir().join(format!(
                "tuneforge-mobile-storage-{label}-{}",
                new_id("test")
            ));
            let data = parent.join("data");
            fs::create_dir_all(&data).unwrap();
            Self { parent, data }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.parent);
        }
    }

    fn project_id(byte: char) -> String {
        source_hash_to_project_id(&byte.to_string().repeat(64)).unwrap()
    }

    fn insert_project(connection: &Connection, project_id: &str, source_path: &Path) {
        connection
            .execute(
                "INSERT INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at)
                 VALUES (?1, 'Storage Test', ?2, ?2, 'local', ?3, ?3)",
                params![project_id, source_path.to_string_lossy(), now_iso()],
            )
            .unwrap();
    }

    fn insert_artifact(
        connection: &Connection,
        artifact_id: &str,
        project_id: &str,
        path: &Path,
        metadata: Value,
    ) {
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at)
                 VALUES (?1, ?2, 'preview_mix', 'wav', ?3, 0, 'test', 1, 1, ?4, ?5)",
                params![
                    artifact_id,
                    project_id,
                    path.to_string_lossy(),
                    metadata.to_string(),
                    now_iso(),
                ],
            )
            .unwrap();
    }

    fn write(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn reconciliation_preserves_live_ownership_and_never_follows_symlinks() {
        let temp = TestRoot::new("ownership");
        let connection = db_at_root(&temp.data).unwrap();
        let target_id = project_id('a');
        let other_id = project_id('b');
        let target_root = project_root_path(&temp.data, &target_id).unwrap();
        let source = target_root.join("source/source.wav");
        let missing = target_root.join("previews/missing.wav");
        let cross_project = target_root.join("previews/cross-project.wav");
        let analysis = target_root.join("analysis/analysis.json");
        let chords = target_root.join("analysis/chords.json");
        let lyrics = target_root.join("analysis/lyrics.json");
        let stale_analysis = target_root.join("analysis/old.json");
        let stale_stem = target_root.join("stems/old-stemset/vocals.wav");
        let empty_nested = target_root.join("previews/empty/nested");
        let external_file = temp.parent.join("external.wav");
        let external_target = temp.parent.join("external-target.wav");
        let external_dir = temp.parent.join("external-dir");
        let linked_file = external_dir.join("linked.wav");
        let stale_link = target_root.join("stems/external-link.wav");
        let referenced_link = target_root.join("linked-parent");

        for (path, contents) in [
            (&source, b"source".as_slice()),
            (&cross_project, b"cross"),
            (&analysis, b"analysis"),
            (&chords, b"chords"),
            (&lyrics, b"lyrics"),
            (&stale_analysis, b"stale"),
            (&stale_stem, b"stem"),
            (&external_file, b"external"),
            (&external_target, b"target"),
            (&linked_file, b"linked"),
        ] {
            write(path, contents);
        }
        fs::create_dir_all(&empty_nested).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&external_target, &stale_link).unwrap();
            std::os::unix::fs::symlink(&external_dir, &referenced_link).unwrap();
        }

        insert_project(&connection, &target_id, &source);
        insert_project(&connection, &other_id, &external_file);
        insert_artifact(&connection, "source", &target_id, &source, json!({}));
        insert_artifact(&connection, "missing", &target_id, &missing, json!({}));
        insert_artifact(
            &connection,
            "external",
            &target_id,
            &external_file,
            json!({"playback_path": referenced_link.join("linked.wav")}),
        );
        insert_artifact(&connection, "cross", &other_id, &cross_project, json!({}));
        for sql in [
            "INSERT INTO analysis_results (project_id, analysis_version, created_at) VALUES (?1, 'test', ?2)",
            "INSERT INTO chord_timelines (project_id, source_segments_json, segments_json, timeline_json, source_kind, metadata_json, has_user_edits, created_at, updated_at) VALUES (?1, '[]', '[]', '[]', 'generated', '{}', 0, ?2, ?2)",
            "INSERT INTO lyrics_transcripts (project_id, backend, source_kind, source_segments_json, segments_json, has_user_edits, created_at, updated_at) VALUES (?1, 'test', 'generated', '[]', '[]', 0, ?2, ?2)",
        ] {
            connection.execute(sql, params![&target_id, now_iso()]).unwrap();
        }

        reconcile_project_storage(&connection, &temp.data, &target_id).unwrap();
        reconcile_project_storage(&connection, &temp.data, &target_id).unwrap();

        for path in [&source, &cross_project, &analysis, &chords, &lyrics] {
            assert!(path.exists(), "{} should remain", path.display());
        }
        assert!(!stale_analysis.exists());
        assert!(!stale_stem.exists());
        assert!(!stale_stem.parent().unwrap().exists());
        assert!(!empty_nested.exists());
        #[cfg(unix)]
        {
            assert!(!stale_link.exists());
            assert!(referenced_link.is_symlink());
        }
        assert_eq!(fs::read(&external_file).unwrap(), b"external");
        assert_eq!(fs::read(&external_target).unwrap(), b"target");
        assert_eq!(fs::read(&linked_file).unwrap(), b"linked");
        let missing_row: i64 = connection
            .query_row(
                "SELECT count(*) FROM artifacts WHERE id='missing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing_row, 1);
    }

    #[test]
    fn reconciliation_defers_unsafe_roots_then_rebuilds_ownership_after_commit() {
        let temp = TestRoot::new("lifecycle");
        let connection = db_at_root(&temp.data).unwrap();
        let target_id = project_id('c');
        let delete_id = project_id('d');
        let target_root = project_root_path(&temp.data, &target_id).unwrap();
        let source = target_root.join("source/source.wav");
        let retired = target_root.join("previews/retired.wav");
        let stale = target_root.join("stems/stale.wav");
        let external_dir = temp.parent.join("external-race");
        let external_victim = external_dir.join("victim.wav");
        for (path, contents) in [
            (&source, b"source".as_slice()),
            (&retired, b"retired"),
            (&stale, b"stale"),
            (&external_victim, b"victim"),
        ] {
            write(path, contents);
        }
        insert_project(&connection, &target_id, &source);
        insert_artifact(&connection, "source", &target_id, &source, json!({}));
        insert_artifact(&connection, "retired", &target_id, &retired, json!({}));

        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        connection
            .execute("DELETE FROM artifacts WHERE id='retired'", [])
            .unwrap();
        connection.execute_batch("ROLLBACK").unwrap();
        assert!(retired.exists());

        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        connection
            .execute("DELETE FROM artifacts WHERE id='retired'", [])
            .unwrap();
        connection.execute_batch("COMMIT").unwrap();
        reconcile_project_storage_after_commit(&connection, &temp.data, &target_id);
        assert!(!retired.exists());
        assert!(!stale.exists());
        assert!(source.exists());

        let saved_root = temp.data.join("saved-project-root");
        fs::rename(&target_root, &saved_root).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external_dir, &target_root).unwrap();
        #[cfg(unix)]
        {
            reconcile_project_storage_after_commit(&connection, &temp.data, &target_id);
            assert!(target_root.is_symlink());
        }
        assert_eq!(fs::read(&external_victim).unwrap(), b"victim");
        #[cfg(unix)]
        fs::remove_file(&target_root).unwrap();
        fs::rename(&saved_root, &target_root).unwrap();

        let late_owned = target_root.join("previews/late.wav");
        let late_stale = target_root.join("stems/late-stale.wav");
        write(&late_owned, b"late owned");
        write(&late_stale, b"late stale");
        insert_artifact(&connection, "late", &target_id, &late_owned, json!({}));
        reconcile_project_storage_after_commit(&connection, &temp.data, &delete_id);
        assert!(source.exists());
        assert!(late_owned.exists());
        assert!(!late_stale.exists());
        assert_eq!(fs::read(&external_victim).unwrap(), b"victim");

        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        connection
            .execute(
                "UPDATE projects SET sync_status = 'deleted' WHERE id = ?1",
                params![&target_id],
            )
            .unwrap();
        connection.execute_batch("COMMIT").unwrap();
        reconcile_project_storage_after_commit(&connection, &temp.data, &target_id);
        assert!(!target_root.exists());

        let delete_root = project_root_path(&temp.data, &delete_id).unwrap();
        let delete_source = delete_root.join("source/source.wav");
        write(&delete_source, b"delete");
        insert_project(&connection, &delete_id, &delete_source);
        insert_artifact(&connection, "delete", &delete_id, &delete_source, json!({}));
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        connection
            .execute(
                "DELETE FROM artifacts WHERE project_id = ?1",
                params![&delete_id],
            )
            .unwrap();
        connection
            .execute("DELETE FROM projects WHERE id = ?1", params![&delete_id])
            .unwrap();
        assert!(delete_root.exists());
        connection.execute_batch("COMMIT").unwrap();
        reconcile_project_storage_after_commit(&connection, &temp.data, &delete_id);
        assert!(!delete_root.exists());
    }
}
