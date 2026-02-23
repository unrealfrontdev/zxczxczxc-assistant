// project_indexer.rs — walk a local directory and collect source files for RAG context
use serde::{Deserialize, Serialize};
use std::path::Path;
use walkdir::WalkDir;

/// Hard limits to keep the LLM context window reasonable
const MAX_FILE_SIZE_BYTES: u64  = 100_000; // 100 KB per file
const MAX_FILE_CONTENT_CHARS: usize = 8_000;  // chars sent per file
const MAX_TOTAL_FILES: usize     = 250;

static ALLOWED_EXTENSIONS: &[&str] = &[
    // Systems / compiled
    "rs", "go", "cpp", "c", "h", "hpp", "cs", "java", "swift", "kt",
    // Scripted / interpreted
    "ts", "tsx", "js", "jsx", "py", "rb", "php",
    // Web
    "html", "css", "scss", "sass", "vue", "svelte",
    // Config / data
    "toml", "yaml", "yml", "json", "env", "sh", "bash", "zsh",
    // Docs
    "md", "mdx", "txt",
];

static IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", ".next", "dist", "build",
    "__pycache__", ".venv", "venv", ".idea", ".vscode", ".cargo",
    "out", ".turbo", "coverage", ".pytest_cache",
];

// ── Public types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexedFile {
    pub path:       String,   // relative to root
    pub content:    String,
    pub size_bytes: u64,
    pub extension:  String,
    pub truncated:  bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexResult {
    pub files:         Vec<IndexedFile>,
    pub total_files:   usize,
    pub skipped_files: usize,
    pub root_path:     String,
}

// ── Tauri commands ───────────────────────────────────────────────────────

/// Recursively walk `dir_path` and return readable source files.
#[tauri::command]
pub async fn index_directory(dir_path: String) -> Result<IndexResult, String> {
    let root = Path::new(&dir_path);
    if !root.exists() || !root.is_dir() {
        return Err(format!("'{}' is not a valid directory", dir_path));
    }

    let mut files:   Vec<IndexedFile> = Vec::new();
    let mut skipped: usize             = 0;

    'walk: for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_ignored_dir(e.path()))
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        // Enforce file count limit
        if files.len() >= MAX_TOTAL_FILES {
            skipped += 1;
            continue 'walk;
        }

        let path = entry.path();
        let ext  = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            skipped += 1;
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m)  => m,
            Err(_) => { skipped += 1; continue; }
        };

        if meta.len() > MAX_FILE_SIZE_BYTES {
            skipped += 1;
            continue;
        }

        let raw = match std::fs::read_to_string(path) {
            Ok(s)  => s,
            Err(_) => { skipped += 1; continue; }
        };

        let truncated = raw.len() > MAX_FILE_CONTENT_CHARS;
        let content   = if truncated {
            format!(
                "{}\n\n[… truncated at {} chars …]",
                &raw[..MAX_FILE_CONTENT_CHARS],
                MAX_FILE_CONTENT_CHARS
            )
        } else {
            raw
        };

        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        files.push(IndexedFile {
            path: relative,
            content,
            size_bytes: meta.len(),
            extension: ext,
            truncated,
        });
    }

    let total = files.len();
    log::info!(
        "Indexed {} files from '{}' ({} skipped)",
        total, dir_path, skipped
    );

    Ok(IndexResult {
        files,
        total_files: total,
        skipped_files: skipped,
        root_path: dir_path,
    })
}

/// Read a single file (up to MAX_FILE_SIZE_BYTES).
#[tauri::command]
pub async fn read_file_content(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_SIZE_BYTES {
        return Err(format!(
            "File exceeds limit ({} KB). Max is {} KB.",
            meta.len() / 1_000,
            MAX_FILE_SIZE_BYTES / 1_000
        ));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Write (overwrite or create) a file with the given content.
/// Parent directories are created automatically.
#[tauri::command]
pub async fn write_file(file_path: String, content: String) -> Result<(), String> {
    let path = Path::new(&file_path);

    // Safety: refuse to write outside any reasonable filesystem path
    if file_path.is_empty() {
        return Err("file_path must not be empty".into());
    }

    // Create parent dirs if needed
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    std::fs::write(path, content.as_bytes())
        .map_err(|e| format!("Failed to write '{}': {}", file_path, e))?;

    log::info!("write_file: wrote {} bytes → {}", content.len(), file_path);
    Ok(())
}

/// Delete a single file from disk.
/// Returns an error if the path does not exist or is a directory.
#[tauri::command]
pub async fn delete_file(file_path: String) -> Result<(), String> {
    if file_path.is_empty() {
        return Err("file_path must not be empty".into());
    }
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    if path.is_dir() {
        return Err(format!(
            "'{}' is a directory — use delete_directory to remove directories",
            file_path
        ));
    }
    std::fs::remove_file(path)
        .map_err(|e| format!("Failed to delete '{}': {}", file_path, e))?;

    log::info!("delete_file: deleted {}", file_path);
    Ok(())
}

/// Apply a targeted string replacement inside a file.
/// Fails if `old_text` is not found exactly once.
#[tauri::command]
pub async fn patch_file(
    file_path: String,
    old_text:  String,
    new_text:  String,
) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    let original = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read '{}': {}", file_path, e))?;

    let count = original.matches(old_text.as_str()).count();
    if count == 0 {
        return Err(format!("old_text not found in '{}'", file_path));
    }
    if count > 1 {
        return Err(format!(
            "old_text matches {} times in '{}' — be more specific",
            count, file_path
        ));
    }

    let patched = original.replacen(old_text.as_str(), new_text.as_str(), 1);
    std::fs::write(path, patched.as_bytes())
        .map_err(|e| format!("Failed to write '{}': {}", file_path, e))?;

    log::info!("patch_file: patched {}", file_path);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn is_ignored_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|name| {
            // Hidden directories (except the project root) + known noise dirs
            IGNORED_DIRS.contains(&name) || (name.starts_with('.') && name.len() > 1)
        })
        .unwrap_or(false)
}

// ── Unit tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn make_temp_project() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        // create a source tree
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();

        let mut f = std::fs::File::create(src.join("main.rs")).unwrap();
        writeln!(f, "fn main() {{ println!(\"hello\"); }}").unwrap();

        // file that should be ignored (too large)
        let big = dir.path().join("big.rs");
        let large = "x".repeat(MAX_FILE_SIZE_BYTES as usize + 1);
        std::fs::write(big, large).unwrap();

        // file with ignored extension
        std::fs::write(dir.path().join("image.png"), b"fake png").unwrap();

        // ignored directory
        let node_m = dir.path().join("node_modules").join("lib");
        std::fs::create_dir_all(&node_m).unwrap();
        std::fs::write(node_m.join("index.js"), "// should be ignored").unwrap();

        dir
    }

    #[tokio::test]
    async fn test_index_directory_basic() {
        let tmp = make_temp_project();
        let result = index_directory(tmp.path().to_string_lossy().to_string())
            .await
            .unwrap();

        // Only main.rs should be included
        assert_eq!(result.total_files, 1);
        assert_eq!(result.files[0].path, "src/main.rs");
        assert!(result.skipped_files >= 2); // big.rs + image.png
    }

    #[tokio::test]
    async fn test_index_invalid_path() {
        let result = index_directory("/nonexistent/path/xyz".into()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_read_file_content_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("hello.ts");
        std::fs::write(&file, "export const x = 42;").unwrap();

        let content = read_file_content(file.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(content.trim(), "export const x = 42;");
    }

    #[tokio::test]
    async fn test_read_file_content_missing() {
        let result = read_file_content("/no/such/file.ts".into()).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_is_ignored_dir() {
        assert!(is_ignored_dir(Path::new("node_modules")));
        assert!(is_ignored_dir(Path::new(".git")));
        assert!(is_ignored_dir(Path::new("target")));
        assert!(!is_ignored_dir(Path::new("src")));
    }
}
