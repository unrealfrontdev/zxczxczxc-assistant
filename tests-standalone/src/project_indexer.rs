// project_indexer — pure logic, no Tauri, testable standalone
use std::path::Path;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

const MAX_FILE_SIZE_BYTES: u64  = 100_000;
const MAX_FILE_CONTENT_CHARS: usize = 8_000;
const MAX_TOTAL_FILES: usize    = 250;

static ALLOWED_EXTENSIONS: &[&str] = &[
    "rs", "go", "cpp", "c", "h", "cs", "java", "swift", "kt",
    "ts", "tsx", "js", "jsx", "py", "rb", "php",
    "html", "css", "scss", "vue", "svelte",
    "toml", "yaml", "yml", "json", "env", "sh", "md", "txt",
];

static IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", ".next", "dist", "build",
    "__pycache__", ".venv", "venv", ".idea", ".vscode", ".cargo",
    "out", "coverage",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexedFile {
    pub path:       String,
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

pub fn index_directory_sync(dir_path: &str) -> Result<IndexResult, String> {
    let root = Path::new(dir_path);
    if !root.exists() || !root.is_dir() {
        return Err(format!("'{}' is not a valid directory", dir_path));
    }

    let mut files:   Vec<IndexedFile> = Vec::new();
    let mut skipped: usize             = 0;

    'walk: for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Allow the root entry (depth 0) unconditionally; only filter descendants
            e.depth() == 0 || !is_ignored_dir(e.path())
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() { continue; }
        if files.len() >= MAX_TOTAL_FILES { skipped += 1; continue 'walk; }

        let path = entry.path();
        let ext  = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) { skipped += 1; continue; }

        let meta = match entry.metadata() { Ok(m) => m, Err(_) => { skipped += 1; continue; } };
        if meta.len() > MAX_FILE_SIZE_BYTES { skipped += 1; continue; }

        let raw = match std::fs::read_to_string(path) { Ok(s) => s, Err(_) => { skipped += 1; continue; } };

        let truncated = raw.len() > MAX_FILE_CONTENT_CHARS;
        let content   = if truncated {
            format!("{}\n\n[… truncated …]", &raw[..MAX_FILE_CONTENT_CHARS])
        } else { raw };

        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        files.push(IndexedFile { path: relative, content, size_bytes: meta.len(), extension: ext, truncated });
    }

    let total = files.len();
    Ok(IndexResult { files, total_files: total, skipped_files: skipped, root_path: dir_path.into() })
}

pub fn read_file_content_sync(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);
    if !path.exists() { return Err(format!("File not found: {}", file_path)); }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_SIZE_BYTES {
        return Err(format!("File too large ({} KB > 100 KB)", meta.len() / 1000));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

fn is_ignored_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|name| IGNORED_DIRS.contains(&name) || (name.starts_with('.') && name.len() > 1))
        .unwrap_or(false)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_temp_project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();

        // Valid file
        let mut f = std::fs::File::create(src.join("main.rs")).unwrap();
        writeln!(f, "fn main() {{ println!(\"hello\"); }}").unwrap();

        // Too large — should be skipped
        let large = "x".repeat(MAX_FILE_SIZE_BYTES as usize + 1);
        std::fs::write(dir.path().join("big.rs"), large).unwrap();

        // Wrong extension — should be skipped
        std::fs::write(dir.path().join("image.jpg"), b"fake").unwrap();

        // Ignored directory — contents should be skipped
        let node_m = dir.path().join("node_modules").join("lib");
        std::fs::create_dir_all(&node_m).unwrap();
        std::fs::write(node_m.join("index.js"), "// should be ignored").unwrap();

        dir
    }

    #[test]
    fn test_index_includes_only_valid_files() {
        let tmp = make_temp_project();
        let res = index_directory_sync(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(res.total_files, 1, "only main.rs should be indexed");
        assert_eq!(res.files[0].path, "src/main.rs");
        assert!(res.skipped_files >= 2);
    }

    #[test]
    fn test_index_invalid_path() {
        let res = index_directory_sync("/no/such/dir");
        assert!(res.is_err());
    }

    #[test]
    fn test_read_file_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let p   = tmp.path().join("hello.ts");
        std::fs::write(&p, "export const x = 42;").unwrap();
        let content = read_file_content_sync(p.to_str().unwrap()).unwrap();
        assert_eq!(content.trim(), "export const x = 42;");
    }

    #[test]
    fn test_read_file_missing() {
        let res = read_file_content_sync("/no/such/file.ts");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_read_file_too_large() {
        let tmp   = tempfile::tempdir().unwrap();
        let big   = tmp.path().join("big.rs");
        std::fs::write(&big, "x".repeat(MAX_FILE_SIZE_BYTES as usize + 1)).unwrap();
        let res   = read_file_content_sync(big.to_str().unwrap());
        assert!(res.is_err());
    }

    #[test]
    fn test_is_ignored_dir_known() {
        assert!(is_ignored_dir(Path::new("node_modules")));
        assert!(is_ignored_dir(Path::new(".git")));
        assert!(is_ignored_dir(Path::new("target")));
        assert!(is_ignored_dir(Path::new(".venv")));
    }

    #[test]
    fn test_is_ignored_dir_allowed() {
        assert!(!is_ignored_dir(Path::new("src")));
        assert!(!is_ignored_dir(Path::new("lib")));
        assert!(!is_ignored_dir(Path::new("components")));
    }

    #[test]
    fn test_truncation() {
        let tmp = tempfile::tempdir().unwrap();
        let p   = tmp.path().join("long.md");
        let big_content = "A".repeat(MAX_FILE_CONTENT_CHARS + 500);
        std::fs::write(&p, &big_content).unwrap();

        let res = index_directory_sync(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(res.total_files, 1);
        assert!(res.files[0].truncated);
        assert!(res.files[0].content.contains("truncated"));
    }
}
