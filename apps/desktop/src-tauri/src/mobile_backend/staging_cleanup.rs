use super::storage_cleanup::{
    ensure_owned_directory, lexical_absolute, path_identity, require_stable_directory,
    EntryIdentity, EntryKind,
};
use super::*;
use std::sync::{Mutex, MutexGuard, OnceLock};

const STAGING_REFERENCES_KEY: &str = "_tuneforge_staging_references_v1";

static STAGING_MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct StagingReference {
    project_id: String,
    artifact_id: String,
}

pub(super) fn staging_mutation_guard() -> MutexGuard<'static, ()> {
    STAGING_MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn public_staging_metadata(mut metadata: Value) -> Value {
    if let Value::Object(values) = &mut metadata {
        values.remove(STAGING_REFERENCES_KEY);
    }
    metadata
}

pub(super) fn merge_staging_metadata(
    existing_raw: Option<&str>,
    mut incoming: Value,
) -> Result<Value, String> {
    let mut references = match existing_raw {
        Some(raw) => {
            staged_references(&serde_json::from_str(raw).map_err(|_| {
                "Staged sync artifact metadata is unreadable; update deferred.".to_string()
            })?)?
            .0
        }
        None => BTreeMap::new(),
    };
    if let Some(reference) = legacy_reference(&incoming) {
        references.insert(reference_key(&reference), reference);
    }
    let values = incoming
        .as_object_mut()
        .ok_or_else(|| "Staged sync artifact metadata must be a JSON object.".to_string())?;
    values.remove(STAGING_REFERENCES_KEY);
    values.insert(
        STAGING_REFERENCES_KEY.to_string(),
        serde_json::to_value(references.into_values().collect::<Vec<_>>())
            .map_err(|error| error.to_string())?,
    );
    Ok(incoming)
}

pub(super) fn prepare_staging_destination(
    root: &Path,
    content_sha256: &str,
) -> Result<(String, PathBuf), String> {
    let relative_path = sync_staging_relative_path(content_sha256)?;
    let staging_root = lexical_absolute(&root.join("sync").join("staging"))?;
    let destination = lexical_absolute(&staging_root.join(&relative_path))?;
    if !destination.starts_with(staging_root.join("sha256")) {
        return Err("Staged artifact destination escapes app storage.".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Staged artifact destination has no safe parent.".to_string())?;
    ensure_owned_directory(root, parent)?;
    match path_identity(&destination)? {
        None
        | Some(EntryIdentity {
            kind: EntryKind::File,
            ..
        }) => Ok((relative_path, destination)),
        _ => Err("Staged artifact destination is not a safe file.".to_string()),
    }
}

pub(super) fn staging_file_matches(
    root: &Path,
    path: &Path,
    content_sha256: &str,
    size_bytes: i64,
) -> bool {
    safe_staging_file_identity(root, path)
        .ok()
        .flatten()
        .filter(|identity| identity.kind == EntryKind::File)
        .is_some_and(|_| {
            fs::symlink_metadata(path)
                .ok()
                .is_some_and(|metadata| metadata.len() as i64 == size_bytes)
                && file_sha256(path).ok().as_deref() == Some(content_sha256)
        })
}

pub(super) fn replace_staging_file(
    root: &Path,
    source: &Path,
    destination: &Path,
    content_sha256: &str,
    size_bytes: i64,
) -> Result<EntryIdentity, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Staged artifact destination has no safe parent.".to_string())?;
    let parent_identity = safe_directory_identity(root, parent)?;
    if path_identity(destination)?.is_some_and(|identity| identity.kind != EntryKind::File) {
        return Err("Staged artifact destination changed before write.".to_string());
    }
    let temp_path = parent.join(format!(".{}.{}.partial", content_sha256, new_id("stage")));
    let copy_result = (|| -> Result<EntryIdentity, String> {
        let mut source_file = fs::File::open(source).map_err(|error| error.to_string())?;
        let mut temp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        io::copy(&mut source_file, &mut temp_file).map_err(|error| error.to_string())?;
        temp_file.sync_all().map_err(|error| error.to_string())?;
        drop(temp_file);
        if !staging_file_matches(root, &temp_path, content_sha256, size_bytes) {
            return Err("Copied staged artifact did not match requested content.".to_string());
        }
        require_stable_directory(parent, &parent_identity)?;
        if path_identity(destination)?.is_some_and(|identity| identity.kind != EntryKind::File) {
            return Err("Staged artifact destination changed before write.".to_string());
        }
        fs::rename(&temp_path, destination).map_err(|error| error.to_string())?;
        if !staging_file_matches(root, destination, content_sha256, size_bytes) {
            return Err("Installed staged artifact did not match requested content.".to_string());
        }
        path_identity(destination)?
            .ok_or_else(|| "Installed staged artifact disappeared before persistence.".to_string())
    })();
    if copy_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    copy_result
}

pub(super) fn register_staged_reference(
    connection: &Connection,
    root: &Path,
    content_sha256: &str,
    project_id: &str,
    artifact_id: &str,
    expected_size_bytes: Option<i64>,
) -> Result<bool, String> {
    let _guard = staging_mutation_guard();
    let normalized = normalize_sha256(content_sha256, "content_sha256")?;
    let raw = connection
        .query_row(
            "SELECT metadata_json FROM sync_staged_artifacts WHERE content_sha256 = ?1",
            params![&normalized],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(false);
    };
    let _ = get_staged_artifact(connection, root, &normalized, expected_size_bytes)?;
    let metadata = merge_staging_metadata(
        Some(&raw),
        json!({"project_id": project_id, "artifact_id": artifact_id}),
    )?;
    connection
        .execute(
            "UPDATE sync_staged_artifacts SET metadata_json = ?1, updated_at = ?2 WHERE content_sha256 = ?3",
            params![metadata.to_string(), now_iso(), normalized],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

pub(super) fn register_manifest_staged_references(
    connection: &Connection,
    root: &Path,
    manifests: &[SyncProjectManifestSchema],
) -> Result<(), String> {
    let _guard = staging_mutation_guard();
    for artifact in manifests.iter().flat_map(|manifest| &manifest.artifacts) {
        let raw = connection
            .query_row(
                "SELECT metadata_json FROM sync_staged_artifacts WHERE content_sha256 = ?1",
                params![&artifact.content_sha256],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(raw) = raw else {
            continue;
        };
        let _ = get_staged_artifact(
            connection,
            root,
            &artifact.content_sha256,
            Some(artifact.size_bytes),
        )?;
        let metadata = merge_staging_metadata(
            Some(&raw),
            json!({
                "project_id": artifact.project_id,
                "artifact_id": artifact.artifact_id,
            }),
        )?;
        connection
            .execute(
                "UPDATE sync_staged_artifacts SET metadata_json = ?1, updated_at = ?2 WHERE content_sha256 = ?3",
                params![metadata.to_string(), now_iso(), &artifact.content_sha256],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn reconcile_staged_artifacts_after_commit(connection: &Connection, root: &Path) {
    let _guard = staging_mutation_guard();
    let _ = reconcile_staged_artifacts(connection, root);
}

fn reconcile_staged_artifacts(connection: &Connection, root: &Path) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT content_sha256, size_bytes, relative_path, metadata_json
             FROM sync_staged_artifacts ORDER BY content_sha256",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    let mut cleanup_failed = false;
    for (content_sha256, size_bytes, relative_path, metadata_raw) in rows {
        cleanup_failed |= reconcile_staged_row(
            connection,
            root,
            &content_sha256,
            size_bytes,
            &relative_path,
            &metadata_raw,
        )
        .is_err();
    }
    if cleanup_failed {
        return Err("Some staged sync artifacts could not be cleaned; retry deferred.".to_string());
    }
    Ok(())
}

fn reconcile_staged_row(
    connection: &Connection,
    root: &Path,
    content_sha256: &str,
    size_bytes: i64,
    relative_path: &str,
    metadata_raw: &str,
) -> Result<(), String> {
    let metadata: Value = serde_json::from_str(metadata_raw).map_err(|_| {
        "Staged sync artifact metadata is unreadable; cleanup deferred.".to_string()
    })?;
    let (references, tracked) = staged_references(&metadata)?;
    let mut remaining = BTreeMap::new();
    let mut installed_count = 0_usize;
    for reference in references.into_values() {
        if reference_is_installed(connection, root, &reference, content_sha256, size_bytes)? {
            installed_count += 1;
        } else {
            remaining.insert(reference_key(&reference), reference);
        }
    }
    if !remaining.is_empty() {
        if installed_count > 0 {
            let updated = metadata_with_references(metadata, remaining.into_values())?;
            connection
                .execute(
                    "UPDATE sync_staged_artifacts SET metadata_json = ?1, updated_at = ?2 WHERE content_sha256 = ?3",
                    params![updated.to_string(), now_iso(), content_sha256],
                )
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let verified_legacy_duplicate = !tracked
        && verified_installed_artifact_exists(connection, root, content_sha256, size_bytes)?;
    if installed_count == 0 && !verified_legacy_duplicate {
        return Ok(());
    }
    remove_staged_blob(root, content_sha256, size_bytes, relative_path)?;
    connection
        .execute(
            "DELETE FROM sync_staged_artifacts WHERE content_sha256 = ?1",
            params![content_sha256],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn staged_references(
    metadata: &Value,
) -> Result<(BTreeMap<String, StagingReference>, bool), String> {
    if let Some(value) = metadata.get(STAGING_REFERENCES_KEY) {
        let parsed =
            serde_json::from_value::<Vec<StagingReference>>(value.clone()).map_err(|_| {
                "Staged sync artifact references are unreadable; cleanup deferred.".to_string()
            })?;
        let references = parsed
            .into_iter()
            .filter(|reference| {
                !reference.project_id.is_empty() && !reference.artifact_id.is_empty()
            })
            .map(|reference| (reference_key(&reference), reference))
            .collect();
        return Ok((references, true));
    }
    let mut references = BTreeMap::new();
    if let Some(reference) = legacy_reference(metadata) {
        references.insert(reference_key(&reference), reference);
        return Ok((references, true));
    }
    Ok((references, false))
}

fn legacy_reference(metadata: &Value) -> Option<StagingReference> {
    let project_id = metadata.get("project_id")?.as_str()?.trim();
    let artifact_id = metadata.get("artifact_id")?.as_str()?.trim();
    if project_id.is_empty() || artifact_id.is_empty() {
        return None;
    }
    Some(StagingReference {
        project_id: project_id.to_string(),
        artifact_id: artifact_id.to_string(),
    })
}

fn reference_key(reference: &StagingReference) -> String {
    format!("{}\0{}", reference.project_id, reference.artifact_id)
}

fn metadata_with_references(
    mut metadata: Value,
    references: impl Iterator<Item = StagingReference>,
) -> Result<Value, String> {
    let values = metadata
        .as_object_mut()
        .ok_or_else(|| "Staged sync artifact metadata must be a JSON object.".to_string())?;
    values.insert(
        STAGING_REFERENCES_KEY.to_string(),
        serde_json::to_value(references.collect::<Vec<_>>()).map_err(|error| error.to_string())?,
    );
    Ok(metadata)
}

fn reference_is_installed(
    connection: &Connection,
    root: &Path,
    reference: &StagingReference,
    content_sha256: &str,
    size_bytes: i64,
) -> Result<bool, String> {
    let artifact = connection
        .query_row(
            "SELECT artifacts.path
             FROM artifacts JOIN projects ON projects.id = artifacts.project_id
             WHERE artifacts.id = ?1 AND artifacts.project_id = ?2
               AND artifacts.content_sha256 = ?3 AND artifacts.size_bytes = ?4
               AND projects.sync_status != 'deleted'",
            params![
                &reference.artifact_id,
                &reference.project_id,
                content_sha256,
                size_bytes,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(artifact.is_some_and(|path| {
        installed_artifact_matches(
            root,
            &reference.project_id,
            Path::new(&path),
            content_sha256,
            size_bytes,
        )
    }))
}

fn verified_installed_artifact_exists(
    connection: &Connection,
    root: &Path,
    content_sha256: &str,
    size_bytes: i64,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare(
            "SELECT artifacts.project_id, artifacts.path
             FROM artifacts JOIN projects ON projects.id = artifacts.project_id
             WHERE artifacts.content_sha256 = ?1 AND artifacts.size_bytes = ?2
               AND projects.sync_status != 'deleted'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![content_sha256, size_bytes], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (project_id, path) = row.map_err(|error| error.to_string())?;
        if installed_artifact_matches(
            root,
            &project_id,
            Path::new(&path),
            content_sha256,
            size_bytes,
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn installed_artifact_matches(
    root: &Path,
    project_id: &str,
    path: &Path,
    content_sha256: &str,
    size_bytes: i64,
) -> bool {
    let Ok(project_root) = project_root_path(root, project_id) else {
        return false;
    };
    let Ok(path) = lexical_absolute(path) else {
        return false;
    };
    let Ok(project_root) = lexical_absolute(&project_root) else {
        return false;
    };
    if !path.starts_with(&project_root) || path == project_root {
        return false;
    }
    let Ok(Some(identity)) = path_identity(&path) else {
        return false;
    };
    if identity.kind != EntryKind::File {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return false;
    };
    if metadata.len() as i64 != size_bytes {
        return false;
    }
    let Ok(canonical_project_root) = project_root.canonicalize() else {
        return false;
    };
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    canonical_path.starts_with(canonical_project_root)
        && file_sha256(&path).ok().as_deref() == Some(content_sha256)
}

fn remove_staged_blob(
    root: &Path,
    content_sha256: &str,
    size_bytes: i64,
    relative_path: &str,
) -> Result<(), String> {
    let expected_relative = sync_staging_relative_path(content_sha256)?;
    if relative_path != expected_relative {
        return Err("Staged artifact cleanup path is not content-addressed.".to_string());
    }
    let path = lexical_absolute(&root.join("sync").join("staging").join(relative_path))?;
    let Some(identity) = safe_staging_file_identity(root, &path)? else {
        return Ok(());
    };
    if identity.kind != EntryKind::File
        || !staging_file_matches(root, &path, content_sha256, size_bytes)
    {
        return Err("Staged artifact changed before cleanup; deletion deferred.".to_string());
    }
    remove_staging_file_if_unchanged(root, &path, &identity)
}

pub(super) fn remove_staging_file_if_unchanged(
    root: &Path,
    path: &Path,
    expected_identity: &EntryIdentity,
) -> Result<(), String> {
    if safe_staging_file_identity(root, path)?.as_ref() != Some(expected_identity) {
        return Err("Staged artifact changed before cleanup; deletion deferred.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Staged artifact has no safe parent.".to_string())?;
    let parent_identity = safe_directory_identity(root, parent)?;
    require_stable_directory(parent, &parent_identity)?;
    if path_identity(path)?.as_ref() != Some(expected_identity) {
        return Err("Staged artifact changed before cleanup; deletion deferred.".to_string());
    }
    fs::remove_file(path).map_err(|error| error.to_string())
}

fn safe_staging_file_identity(root: &Path, path: &Path) -> Result<Option<EntryIdentity>, String> {
    let staging_root = lexical_absolute(&root.join("sync").join("staging").join("sha256"))?;
    let path = lexical_absolute(path)?;
    if !path.starts_with(&staging_root) || path == staging_root {
        return Err("Staged artifact path escapes app storage.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Staged artifact has no safe parent.".to_string())?;
    validate_staging_directory_tree(root, parent)?;
    let identity = path_identity(&path)?;
    if let Some(identity) = &identity {
        if identity.kind != EntryKind::File {
            return Err("Staged artifact path is not a safe file.".to_string());
        }
        let canonical_staging_root = staging_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical_path.starts_with(canonical_staging_root) {
            return Err("Staged artifact path escapes app storage.".to_string());
        }
    }
    Ok(identity)
}

fn safe_directory_identity(root: &Path, path: &Path) -> Result<EntryIdentity, String> {
    validate_staging_directory_tree(root, path)?;
    path_identity(path)?
        .filter(|identity| identity.kind == EntryKind::Directory)
        .ok_or_else(|| "Staged artifact parent is not a safe directory.".to_string())
}

fn validate_staging_directory_tree(root: &Path, directory: &Path) -> Result<(), String> {
    let root = lexical_absolute(root)?;
    let directory = lexical_absolute(directory)?;
    let relative = directory
        .strip_prefix(&root)
        .map_err(|_| "Staging directory escapes app storage.".to_string())?;
    let mut parent = root.clone();
    let mut parent_identity = path_identity(&parent)?
        .filter(|identity| identity.kind == EntryKind::Directory)
        .ok_or_else(|| "Mobile app data root is not a safe directory.".to_string())?;
    for component in relative.components() {
        require_stable_directory(&parent, &parent_identity)?;
        let child = parent.join(component.as_os_str());
        require_stable_directory(&parent, &parent_identity)?;
        let child_identity = path_identity(&child)?
            .filter(|identity| identity.kind == EntryKind::Directory)
            .ok_or_else(|| "Staging directory is not safe.".to_string())?;
        require_stable_directory(&child, &child_identity)?;
        parent = child;
        parent_identity = child_identity;
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_directory.starts_with(canonical_root) {
        return Err("Staging directory escapes app storage.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::storage::{stage_sync_artifact, staged_artifact_path};
    use super::*;

    struct TestRoot {
        parent: PathBuf,
        data: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let parent =
                std::env::temp_dir().join(format!("tuneforge-mobile-staging-{}", new_id("test")));
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

    fn stage(
        connection: &Connection,
        root: &Path,
        source: &Path,
        hash: &str,
        project_id: &str,
        artifact_id: &str,
    ) -> Result<SyncStagedArtifactSchema, String> {
        stage_sync_artifact(
            connection,
            root,
            SyncArtifactStagingRequest {
                source_path: source.to_string_lossy().into_owned(),
                content_sha256: hash.to_string(),
                size_bytes: fs::metadata(source).unwrap().len() as i64,
                provider_device_id: Some("peer".to_string()),
                metadata: json!({"project_id": project_id, "artifact_id": artifact_id}),
            },
        )
    }

    fn install(
        connection: &Connection,
        root: &Path,
        project_id: &str,
        artifact_id: &str,
        bytes: &[u8],
        hash: &str,
    ) -> PathBuf {
        let path = project_root_path(root, project_id)
            .unwrap()
            .join(format!("source/{artifact_id}.wav"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, display_name, source_path, imported_path, sync_status, created_at, updated_at)
                 VALUES (?1, 'Staging Test', ?2, ?2, 'local', ?3, ?3)",
                params![project_id, path.to_string_lossy(), now_iso()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at)
                 VALUES (?1, ?2, 'source_audio', 'wav', ?3, ?4, ?5, 'sync', 0, 0, '{}', ?6)",
                params![
                    artifact_id,
                    project_id,
                    path.to_string_lossy(),
                    hash,
                    bytes.len() as i64,
                    now_iso(),
                ],
            )
            .unwrap();
        path
    }

    #[test]
    fn staging_references_converge_without_losing_pending_or_unsafe_content() {
        let temp = TestRoot::new();
        let connection = db_at_root(&temp.data).unwrap();
        let shared = b"shared staged bytes";
        let shared_source = temp.parent.join("shared.wav");
        fs::write(&shared_source, shared).unwrap();
        let shared_hash = file_sha256(&shared_source).unwrap();
        let project_a = project_id('a');
        let project_b = project_id('b');
        let staged = stage(
            &connection,
            &temp.data,
            &shared_source,
            &shared_hash,
            &project_a,
            "artifact-a",
        )
        .unwrap();
        let public = stage(
            &connection,
            &temp.data,
            &shared_source,
            &shared_hash,
            &project_b,
            "artifact-b",
        )
        .unwrap();
        register_staged_reference(
            &connection,
            &temp.data,
            &shared_hash,
            &project_b,
            "artifact-b",
            None,
        )
        .unwrap();
        assert!(public.metadata.get(STAGING_REFERENCES_KEY).is_none());
        let raw: String = connection
            .query_row(
                "SELECT metadata_json FROM sync_staged_artifacts WHERE content_sha256 = ?1",
                params![&shared_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            staged_references(&serde_json::from_str(&raw).unwrap())
                .unwrap()
                .0
                .len(),
            2
        );

        install(
            &connection,
            &temp.data,
            &project_a,
            "artifact-a",
            shared,
            &shared_hash,
        );
        reconcile_staged_artifacts_after_commit(&connection, &temp.data);
        reconcile_staged_artifacts_after_commit(&connection, &temp.data);
        assert!(staged_artifact_path(&temp.data, &staged.relative_path)
            .unwrap()
            .is_file());
        install(
            &connection,
            &temp.data,
            &project_b,
            "artifact-b",
            shared,
            &shared_hash,
        );
        reconcile_staged_artifacts_after_commit(&connection, &temp.data);
        assert!(get_staged_artifact(&connection, &temp.data, &shared_hash, None).is_err());

        let legacy = b"legacy duplicate";
        let legacy_source = temp.parent.join("legacy.wav");
        fs::write(&legacy_source, legacy).unwrap();
        let legacy_hash = file_sha256(&legacy_source).unwrap();
        let project_c = project_id('c');
        let legacy_staged = stage(
            &connection,
            &temp.data,
            &legacy_source,
            &legacy_hash,
            &project_c,
            "artifact-c",
        )
        .unwrap();
        connection
            .execute(
                "UPDATE sync_staged_artifacts SET metadata_json = ?1 WHERE content_sha256 = ?2",
                params![
                    json!({"project_id": project_c, "artifact_id": "artifact-c"}).to_string(),
                    &legacy_hash,
                ],
            )
            .unwrap();
        install(
            &connection,
            &temp.data,
            &project_c,
            "artifact-c",
            legacy,
            &legacy_hash,
        );
        let legacy_path = staged_artifact_path(&temp.data, &legacy_staged.relative_path).unwrap();
        let external = temp.parent.join("external.wav");
        fs::write(&external, legacy).unwrap();
        #[cfg(unix)]
        {
            fs::remove_file(&legacy_path).unwrap();
            std::os::unix::fs::symlink(&external, &legacy_path).unwrap();
            reconcile_staged_artifacts_after_commit(&connection, &temp.data);
            reconcile_staged_artifacts_after_commit(&connection, &temp.data);
            assert!(legacy_path.is_symlink());
            assert_eq!(fs::read(&external).unwrap(), legacy);
            fs::remove_file(&legacy_path).unwrap();
            fs::write(&legacy_path, legacy).unwrap();
        }
        reconcile_staged_artifacts_after_commit(&connection, &temp.data);
        assert!(get_staged_artifact(&connection, &temp.data, &legacy_hash, None).is_err());
        assert_eq!(fs::read(external).unwrap(), legacy);

        let failed_source = temp.parent.join("failed.wav");
        fs::write(&failed_source, b"failed staged bytes").unwrap();
        let failed_hash = file_sha256(&failed_source).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_staged_insert BEFORE INSERT ON sync_staged_artifacts
                 BEGIN SELECT RAISE(FAIL, 'staging persistence failed'); END;",
            )
            .unwrap();
        assert!(stage(
            &connection,
            &temp.data,
            &failed_source,
            &failed_hash,
            &project_c,
            "artifact-failed",
        )
        .is_err());
        assert!(!temp
            .data
            .join("sync/staging")
            .join(sync_staging_relative_path(&failed_hash).unwrap())
            .exists());
    }
}
