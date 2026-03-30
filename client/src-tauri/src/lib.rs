use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
};
use walkdir::{DirEntry, WalkDir};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const SKIPPED_NAMES: &[&str] = &[
    ".git",
    ".idea",
    ".next",
    ".nuxt",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "venv",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleResult {
    project_name: String,
    project_root: String,
    archive_path: String,
    source_size_bytes: u64,
    archive_size_bytes: u64,
    included_files: usize,
    skipped_entries: Vec<String>,
    summary: String,
    space_saved_percent: f64,
}

#[tauri::command]
fn prepare_project_bundle(project_path: String) -> Result<BundleResult, String> {
    let project_root = PathBuf::from(&project_path);

    if !project_root.exists() {
        return Err("The selected folder does not exist.".to_string());
    }

    if !project_root.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }

    let project_root = fs::canonicalize(project_root)
        .map_err(|error| format!("Failed to resolve the selected folder: {error}"))?;
    let project_name = project_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project")
        .to_string();
    let archive_name = format!("{}-computehive-upload.zip", sanitize_name(&project_name));
    let archive_path = project_root.join(&archive_name);

    let mut skipped_entries = BTreeSet::new();
    let files_to_archive = collect_files(&project_root, &archive_path, &mut skipped_entries)?;

    if files_to_archive.is_empty() {
        return Err(
            "No files remained after removing common generated folders. Pick a source folder with project files."
                .to_string(),
        );
    }

    let archive_file = File::create(&archive_path)
        .map_err(|error| format!("Failed to create the archive file: {error}"))?;
    let mut zip_writer = ZipWriter::new(archive_file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mut source_size_bytes = 0_u64;

    for file_path in &files_to_archive {
        let relative_path = file_path
            .strip_prefix(&project_root)
            .map_err(|error| format!("Failed to build a relative path for the archive: {error}"))?;
        let relative_path = normalize_for_zip(relative_path);

        zip_writer
            .start_file(relative_path, options)
            .map_err(|error| format!("Failed to write a file into the archive: {error}"))?;

        let mut source_file = File::open(file_path)
            .map_err(|error| format!("Failed to open a project file for compression: {error}"))?;
        source_size_bytes += io::copy(&mut source_file, &mut zip_writer)
            .map_err(|error| format!("Failed while compressing project files: {error}"))?;
    }

    zip_writer
        .finish()
        .map_err(|error| format!("Failed to finalize the archive: {error}"))?;

    let archive_size_bytes = fs::metadata(&archive_path)
        .map_err(|error| format!("Failed to inspect the archive file: {error}"))?
        .len();
    let skipped_entries = skipped_entries.into_iter().collect::<Vec<_>>();
    let space_saved_percent = if source_size_bytes == 0 {
        0.0
    } else {
        ((source_size_bytes as f64 - archive_size_bytes as f64) / source_size_bytes as f64
            * 100.0)
            .max(0.0)
    };

    let summary = format!(
        "Compressed {} files from {} into {} and skipped {} bulky paths.",
        files_to_archive.len(),
        project_name,
        archive_name,
        skipped_entries.len()
    );

    Ok(BundleResult {
        project_name,
        project_root: project_root.display().to_string(),
        archive_path: archive_path.display().to_string(),
        source_size_bytes,
        archive_size_bytes,
        included_files: files_to_archive.len(),
        skipped_entries,
        summary,
        space_saved_percent,
    })
}

fn collect_files(
    project_root: &Path,
    archive_path: &Path,
    skipped_entries: &mut BTreeSet<String>,
) -> Result<Vec<PathBuf>, String> {
    let walker = WalkDir::new(project_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| keep_entry(entry, project_root, archive_path, skipped_entries));

    let mut files = Vec::new();

    for entry in walker {
        let entry =
            entry.map_err(|error| format!("Failed while scanning the selected folder: {error}"))?;

        if entry.path() == project_root {
            continue;
        }

        if entry.file_type().is_file() {
            files.push(entry.into_path());
        }
    }

    Ok(files)
}

fn keep_entry(
    entry: &DirEntry,
    project_root: &Path,
    archive_path: &Path,
    skipped_entries: &mut BTreeSet<String>,
) -> bool {
    if entry.path() == project_root {
        return true;
    }

    let Ok(relative_path) = entry.path().strip_prefix(project_root) else {
        return true;
    };

    if entry.path() == archive_path || should_skip(relative_path) {
        skipped_entries.insert(relative_path.display().to_string());
        return false;
    }

    true
}

fn should_skip(relative_path: &Path) -> bool {
    for component in relative_path.components() {
        let Component::Normal(name) = component else {
            continue;
        };

        let Some(name) = name.to_str() else {
            continue;
        };

        if SKIPPED_NAMES.contains(&name) || name == ".DS_Store" {
            return true;
        }
    }

    false
}

fn sanitize_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        "project".to_string()
    } else {
        sanitized
    }
}

fn normalize_for_zip(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![prepare_project_bundle])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
