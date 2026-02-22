// ai_bridge — pure HTTP logic, no Tauri, testable standalone
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiRequest {
    pub api_key:       String,
    pub prompt:        String,
    pub image_base64:  Option<String>,
    pub context_files: Option<Vec<String>>,
    pub model:         Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiResponse {
    pub text:        String,
    pub model:       String,
    pub tokens_used: Option<u32>,
}

/// Build the full prompt with optional RAG context blocks.
pub fn build_prompt(req: &AiRequest) -> String {
    let mut full = req.prompt.clone();
    if let Some(files) = &req.context_files {
        if !files.is_empty() {
            full.push_str("\n\n---\n**PROJECT CONTEXT**\n");
            for chunk in files {
                full.push_str(chunk);
                full.push('\n');
            }
        }
    }
    full
}

/// Validate that an API key is non-empty.
pub fn validate_key(key: &str, provider: &str) -> Result<(), String> {
    if key.is_empty() {
        Err(format!("{} API key is required", provider))
    } else {
        Ok(())
    }
}

/// Truncate context files to fit in the context window.
pub fn prepare_context(
    files: &[crate::project_indexer::IndexedFile],
    max_files: usize,
    max_chars_per_file: usize,
) -> Vec<String> {
    files
        .iter()
        .take(max_files)
        .map(|f| {
            let snippet = if f.content.len() > max_chars_per_file {
                format!("{}\n[…truncated…]", &f.content[..max_chars_per_file])
            } else {
                f.content.clone()
            };
            format!("### {}\n```{}\n{}\n```", f.path, f.extension, snippet)
        })
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_indexer::IndexedFile;

    fn make_req(prompt: &str, files: Option<Vec<&str>>) -> AiRequest {
        AiRequest {
            api_key:       "test-key".into(),
            prompt:        prompt.into(),
            image_base64:  None,
            context_files: files.map(|v| v.iter().map(|s| s.to_string()).collect()),
            model:         None,
        }
    }

    // ── build_prompt ──────────────────────────────────────────────────

    #[test]
    fn test_prompt_no_context() {
        let req = make_req("Hello world", None);
        assert_eq!(build_prompt(&req), "Hello world");
    }

    #[test]
    fn test_prompt_with_context() {
        let req = make_req("Explain code", Some(vec!["### main.rs\n```rust\nfn main(){}\n```"]));
        let out = build_prompt(&req);
        assert!(out.starts_with("Explain code"));
        assert!(out.contains("PROJECT CONTEXT"));
        assert!(out.contains("main.rs"));
    }

    #[test]
    fn test_prompt_empty_context_ignored() {
        let req = make_req("Hi", Some(vec![]));
        assert_eq!(build_prompt(&req), "Hi");
    }

    #[test]
    fn test_prompt_multiple_context_blocks() {
        let req = make_req("Review", Some(vec!["### a.ts\n```ts\nconst x=1\n```", "### b.ts\n```ts\nconst y=2\n```"]));
        let out = build_prompt(&req);
        assert!(out.contains("a.ts"));
        assert!(out.contains("b.ts"));
    }

    // ── validate_key ──────────────────────────────────────────────────

    #[test]
    fn test_validate_key_ok() {
        assert!(validate_key("sk-abc123", "OpenAI").is_ok());
    }

    #[test]
    fn test_validate_key_empty() {
        let err = validate_key("", "OpenAI").unwrap_err();
        assert!(err.contains("required"));
    }

    #[test]
    fn test_validate_key_empty_claude() {
        let err = validate_key("", "Claude").unwrap_err();
        assert!(err.contains("Claude"));
    }

    // ── prepare_context ───────────────────────────────────────────────

    fn fake_file(name: &str, content: &str) -> IndexedFile {
        IndexedFile {
            path:       name.into(),
            content:    content.into(),
            size_bytes: content.len() as u64,
            extension:  "rs".into(),
            truncated:  false,
        }
    }

    #[test]
    fn test_prepare_context_basic() {
        let files = vec![fake_file("src/a.rs", "fn foo() {}")];
        let blocks = prepare_context(&files, 20, 3000);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].contains("src/a.rs"));
        assert!(blocks[0].contains("fn foo() {}"));
    }

    #[test]
    fn test_prepare_context_max_files_respected() {
        let files: Vec<_> = (0..10).map(|i| fake_file(&format!("f{}.rs", i), "x")).collect();
        let blocks = prepare_context(&files, 3, 3000);
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn test_prepare_context_truncation() {
        let big    = "X".repeat(5000);
        let files  = vec![fake_file("big.rs", &big)];
        let blocks = prepare_context(&files, 20, 100);
        assert!(blocks[0].contains("truncated"));
        // actual snippet must not exceed 100 chars + overhead
        let content_len = blocks[0].len();
        assert!(content_len < 500, "block should be small, got {} chars", content_len);
    }

    #[test]
    fn test_prepare_context_empty() {
        let blocks = prepare_context(&[], 20, 3000);
        assert!(blocks.is_empty());
    }
}
