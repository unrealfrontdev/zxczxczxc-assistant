// ai_bridge.rs — HTTP clients for OpenAI Vision, Anthropic Claude, local LLMs + streaming
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::sync::watch;

// ── Global cancellation channel ──────────────────────────────────────────

static CANCEL_TX: OnceLock<watch::Sender<u64>> = OnceLock::new();

fn cancel_tx() -> &'static watch::Sender<u64> {
    CANCEL_TX.get_or_init(|| watch::channel(0).0)
}

/// Subscribe to the cancel channel and bump the generation counter so that
/// any in-flight request sees the change via `watch::Receiver::changed()`.
fn new_cancel_receiver() -> watch::Receiver<u64> {
    cancel_tx().subscribe()
}

/// Cancel the in-flight request (if any). Called from the frontend.
#[tauri::command]
pub fn cancel_ai_request() {
    let tx = cancel_tx();
    let next = *tx.borrow() + 1;
    let _ = tx.send(next);
}

// ── Shared request/response types ───────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct AiRequest {
    pub api_key:       String,
    pub prompt:        String,
    /// Optional system-level instruction (character card, language directive, etc.)
    pub system_prompt: Option<String>,
    /// PNG screenshot encoded as base64 (optional)
    pub image_base64:  Option<String>,
    /// RAG context chunks: each element is a formatted file block
    pub context_files: Option<Vec<String>>,
    /// Override the default model
    pub model:         Option<String>,
    /// Hard cap on output tokens (None = use provider default)
    pub max_tokens:    Option<u32>,
}

/// Request for local LLM servers (LM Studio, Ollama, generic OpenAI-compatible).
#[derive(Debug, Serialize, Deserialize)]
pub struct LocalAiRequest {
    /// Base URL, e.g. "http://localhost:1234" or "http://localhost:11434"
    pub base_url:      String,
    /// Optional Bearer token — most local servers don't require one
    pub api_key:       Option<String>,
    pub prompt:        String,
    /// Optional system-level instruction (character card, language directive, etc.)
    pub system_prompt: Option<String>,
    pub image_base64:  Option<String>,
    pub context_files: Option<Vec<String>>,
    pub model:         Option<String>,
    /// Hard cap on output tokens (None = use server default)
    pub max_tokens:    Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiResponse {
    pub text:        String,
    pub model:       String,
    pub tokens_used: Option<u32>,
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Prepend RAG context to the user prompt
// ── Unit tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_prompt_no_context() {
        let req = AiRequest {
            api_key:       "key".into(),
            prompt:        "What is this?".into(),
            system_prompt: None,
            image_base64:  None,
            context_files: None,
            model:         None,
        };
        assert_eq!(build_prompt(&req), "What is this?");
    }

    #[test]
    fn test_build_prompt_with_context() {
        let req = AiRequest {
            api_key:       "key".into(),
            prompt:        "Explain this code".into(),
            system_prompt: None,
            image_base64:  None,
            context_files: Some(vec!["### main.rs\n```rust\nfn main(){}\n```".into()]),
            model:         None,
        };
        let result = build_prompt(&req);
        assert!(result.contains("PROJECT CONTEXT"));
        assert!(result.contains("main.rs"));
        assert!(result.starts_with("Explain this code"));
    }

    #[test]
    fn test_build_prompt_empty_context_ignored() {
        let req = AiRequest {
            api_key:       "key".into(),
            prompt:        "Hello".into(),
            system_prompt: None,
            image_base64:  None,
            context_files: Some(vec![]),      // empty vec
            model:         None,
        };
        assert_eq!(build_prompt(&req), "Hello");
    }

    #[test]
    fn test_missing_api_key_returns_err() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(analyze_with_openai(AiRequest {
            api_key:       "".into(),
            prompt:        "test".into(),
            system_prompt: None,
            image_base64:  None,
            context_files: None,
            model:         None,
        }));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("API key is required"));
    }

    #[test]
    fn test_missing_api_key_claude_returns_err() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(analyze_with_claude(AiRequest {
            api_key:       "".into(),
            prompt:        "test".into(),
            system_prompt: None,
            image_base64:  None,
            context_files: None,
            model:         None,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_missing_api_key_deepseek_returns_err() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(analyze_with_deepseek(AiRequest {
            api_key:       "".into(),
            prompt:        "test".into(),
            system_prompt: None,
            image_base64:  None,
            context_files: None,
            model:         None,
        }));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("API key is required"));
    }
}

fn build_prompt(req: &AiRequest) -> String {
    let mut full = req.prompt.clone();
    if let Some(files) = &req.context_files {
        if !files.is_empty() {
            full.push_str("\n\n---\n**PROJECT CONTEXT (read-only)**\n");
            for chunk in files {
                full.push_str(chunk);
                full.push('\n');
            }
        }
    }
    full
}

/// Extract the text reply from an OpenAI-compatible JSON response.
/// Falls back to the `reasoning` field (used by CoT / "thinking" models like
/// DeepSeek-R1, LM Studio with heretic/opus-class models) when `content` is
/// empty or missing.
fn extract_content(json: &Value) -> String {
    let msg = &json["choices"][0]["message"];
    let content = msg["content"].as_str().unwrap_or("").trim();
    if !content.is_empty() {
        return content.to_string();
    }
    // CoT models: the actual answer lives in 'reasoning' when content is empty
    let reasoning = msg["reasoning"].as_str().unwrap_or("").trim();
    if !reasoning.is_empty() {
        return format!(
            "{}\n\n*— модель вернула только рассуждения (reasoning). Увеличьте лимит токенов для полного ответа. —*",
            reasoning
        );
    }
    String::new()
}

fn http_client() -> reqwest::Result<Client> {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600)) // 10 min — local LLMs can be slow
        .build()
}

// ═══════════════════════════════════════════════════════════════════════
// OpenAI GPT-4o Vision
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn analyze_with_openai(req: AiRequest) -> Result<AiResponse, String> {
    if req.api_key.is_empty() {
        return Err("OpenAI API key is required".into());
    }

    let mut cancel_rx = new_cancel_receiver();
    tokio::select! {
        result = async {
            let client = http_client().map_err(|e| e.to_string())?;
            let model  = req.model.as_deref().unwrap_or("gpt-4o");

            let mut messages: Vec<Value> = Vec::new();
            // Character / language directive goes as a true system message
            if let Some(sys) = &req.system_prompt {
                if !sys.trim().is_empty() {
                    messages.push(json!({ "role": "system", "content": sys }));
                }
            }

            let mut content: Vec<Value> = vec![json!({
                "type": "text",
                "text": build_prompt(&req)
            })];

            if let Some(b64) = &req.image_base64 {
                content.push(json!({
                    "type": "image_url",
                    "image_url": {
                        "url":    format!("data:image/png;base64,{}", b64),
                        "detail": "high"
                    }
                }));
            }

            messages.push(json!({ "role": "user", "content": content }));

            let max_tok = req.max_tokens.unwrap_or(2048);
            let body = json!({
                "model":      model,
                "messages":   messages,
                "max_tokens": max_tok
            });

            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .bearer_auth(&req.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            let status = resp.status();
            let json: Value = resp.json().await.map_err(|e| e.to_string())?;

            if !status.is_success() {
                return Err(format!(
                    "OpenAI {}: {}",
                    status,
                    json["error"]["message"].as_str().unwrap_or("unknown error")
                ));
            }

            Ok(AiResponse {
                text:        extract_content(&json),
                model:       json["model"].as_str().unwrap_or(model).to_string(),
                tokens_used: json["usage"]["total_tokens"].as_u64().map(|n| n as u32),
            })
        } => result,
        _ = cancel_rx.changed() => Err("__CANCELLED__".into()),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Anthropic Claude 3.x
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn analyze_with_claude(req: AiRequest) -> Result<AiResponse, String> {
    if req.api_key.is_empty() {
        return Err("Anthropic API key is required".into());
    }

    let mut cancel_rx = new_cancel_receiver();
    tokio::select! {
        result = async {
            let client = http_client().map_err(|e| e.to_string())?;
            let model  = req.model.as_deref().unwrap_or("claude-3-5-sonnet-20241022");

            let mut content: Vec<Value> = Vec::new();
            if let Some(b64) = &req.image_base64 {
                content.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": "image/png", "data": b64 }
                }));
            }
            content.push(json!({ "type": "text", "text": build_prompt(&req) }));

            // Claude uses a top-level "system" field, not a message role
            let sys = req.system_prompt.as_deref().unwrap_or("").trim();
            let max_tok = req.max_tokens.unwrap_or(2048);
            let mut body = json!({
                "model":      model,
                "max_tokens": max_tok,
                "messages":   [{ "role": "user", "content": content }]
            });
            if !sys.is_empty() {
                body["system"] = json!(sys);
            }

            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key",         &req.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type",      "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            let status = resp.status();
            let json: Value = resp.json().await.map_err(|e| e.to_string())?;

            if !status.is_success() {
                return Err(format!(
                    "Claude {}: {}",
                    status,
                    json["error"]["message"].as_str().unwrap_or("unknown error")
                ));
            }

            let in_tok  = json["usage"]["input_tokens"].as_u64().unwrap_or(0);
            let out_tok = json["usage"]["output_tokens"].as_u64().unwrap_or(0);

            Ok(AiResponse {
                text: json["content"][0]["text"].as_str().unwrap_or("").to_string(),
                model: json["model"].as_str().unwrap_or(model).to_string(),
                tokens_used: Some((in_tok + out_tok) as u32),
            })
        } => result,
        _ = cancel_rx.changed() => Err("__CANCELLED__".into()),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// DeepSeek (OpenAI-compatible API)
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn analyze_with_deepseek(req: AiRequest) -> Result<AiResponse, String> {
    if req.api_key.is_empty() {
        return Err("DeepSeek API key is required".into());
    }

    let mut cancel_rx = new_cancel_receiver();
    tokio::select! {
        result = async {
            let client = http_client().map_err(|e| e.to_string())?;
            let model  = req.model.as_deref().unwrap_or("deepseek-chat");

            let mut messages: Vec<Value> = Vec::new();
            if let Some(sys) = &req.system_prompt {
                if !sys.trim().is_empty() {
                    messages.push(json!({ "role": "system", "content": sys }));
                }
            }

            // DeepSeek has no vision support — always use a plain string content
            let user_content: Value = json!(build_prompt(&req));
            messages.push(json!({ "role": "user", "content": user_content }));

            let max_tok = req.max_tokens.unwrap_or(2048);
            let body = json!({
                "model":      model,
                "messages":   messages,
                "max_tokens": max_tok
            });

            let resp = client
                .post("https://api.deepseek.com/v1/chat/completions")
                .bearer_auth(&req.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            let status = resp.status();
            let json: Value = resp.json().await.map_err(|e| e.to_string())?;

            if !status.is_success() {
                return Err(format!(
                    "DeepSeek {}: {}",
                    status,
                    json["error"]["message"].as_str().unwrap_or("unknown error")
                ));
            }

            Ok(AiResponse {
                text:        extract_content(&json),
                model:       json["model"].as_str().unwrap_or(model).to_string(),
                tokens_used: json["usage"]["total_tokens"].as_u64().map(|n| n as u32),
            })
        } => result,
        _ = cancel_rx.changed() => Err("__CANCELLED__".into()),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// OpenRouter (unified gateway, OpenAI-compatible)
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn analyze_with_openrouter(req: AiRequest) -> Result<AiResponse, String> {
    if req.api_key.is_empty() {
        return Err("OpenRouter API key is required".into());
    }

    let mut cancel_rx = new_cancel_receiver();
    tokio::select! {
        result = async {
            let client = http_client().map_err(|e| e.to_string())?;
            let model  = req.model.as_deref().unwrap_or("openai/gpt-4o");

            let mut messages: Vec<Value> = Vec::new();
            if let Some(sys) = &req.system_prompt {
                if !sys.trim().is_empty() {
                    messages.push(json!({ "role": "system", "content": sys }));
                }
            }

            // Use image array only when a screenshot is attached; plain string otherwise
            let user_msg = if let Some(b64) = &req.image_base64 {
                json!({ "role": "user", "content": [
                    { "type": "text", "text": build_prompt(&req) },
                    { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", b64) } }
                ]})
            } else {
                json!({ "role": "user", "content": build_prompt(&req) })
            };
            messages.push(user_msg);

            let max_tok = req.max_tokens.unwrap_or(2048);
            let body = json!({
                "model":      model,
                "messages":   messages,
                "max_tokens": max_tok
            });

            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .bearer_auth(&req.api_key)
                .header("HTTP-Referer", "https://github.com/ai-assistant")
                .header("X-Title",     "AI Assistant Overlay")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            let status = resp.status();
            let json: Value = resp.json().await.map_err(|e| e.to_string())?;

            if !status.is_success() {
                return Err(format!(
                    "OpenRouter {}: {}",
                    status,
                    json["error"]["message"].as_str().unwrap_or("unknown error")
                ));
            }

            Ok(AiResponse {
                text:        extract_content(&json),
                model:       json["model"].as_str().unwrap_or(model).to_string(),
                tokens_used: json["usage"]["total_tokens"].as_u64().map(|n| n as u32),
            })
        } => result,
        _ = cancel_rx.changed() => Err("__CANCELLED__".into()),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Local LLM — LM Studio · Ollama · any OpenAI-compatible server
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn analyze_with_local(req: LocalAiRequest) -> Result<AiResponse, String> {
    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(
            "Local LLM server URL is required (e.g. http://localhost:1234/api/v1/chat)".into(),
        );
    }

    let has_path = base.split("://").nth(1).map(|s| s.contains('/')).unwrap_or(false);
    let url = if has_path {
        base.to_string()
    } else {
        format!("{}/v1/chat/completions", base)
    };

    log::info!("local LLM → {}", url);

    let mut cancel_rx = new_cancel_receiver();
    tokio::select! {
        result = async {
            let client = http_client().map_err(|e| e.to_string())?;
            let model  = req.model.as_deref().unwrap_or("local-model");

            let proxy_req = AiRequest {
                api_key:       req.api_key.clone().unwrap_or_default(),
                prompt:        req.prompt.clone(),
                system_prompt: req.system_prompt.clone(),
                image_base64:  req.image_base64.clone(),
                context_files: req.context_files.clone(),
                model:         req.model.clone(),
                max_tokens:    req.max_tokens,
            };

            // Many local models (e.g. LM Studio with Jinja templates) only
            // accept "user" and "assistant" roles and reject "system".
            // Prepend the system prompt to the first user message to be safe.
            let base_prompt = build_prompt(&proxy_req);
            let user_text = if let Some(sys) = &proxy_req.system_prompt {
                let sys = sys.trim();
                if !sys.is_empty() {
                    format!("{}\n\n{}", sys, base_prompt)
                } else {
                    base_prompt
                }
            } else {
                base_prompt
            };

            let mut messages: Vec<Value> = Vec::new();

            // Use multimodal array only when an image is supplied; otherwise
            // send a plain string — many local models reject the array format
            // for text-only requests.
            let user_msg = if let Some(b64) = &req.image_base64 {
                json!({ "role": "user", "content": [
                    { "type": "text", "text": user_text },
                    { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", b64) } }
                ]})
            } else {
                json!({ "role": "user", "content": user_text })
            };
            messages.push(user_msg);

            let max_tok = req.max_tokens.unwrap_or(4096);
            let body = json!({
                "model":      model,
                "messages":   messages,
                "max_tokens": max_tok
                // "stream" is intentionally omitted — some LM Studio versions
                // return 400 when stream:false is present in the body.
                // Omitting it defaults to non-streaming on all compatible servers.
            });

            let mut builder = client.post(&url).json(&body);
            if let Some(key) = &req.api_key {
                if !key.is_empty() {
                    builder = builder.bearer_auth(key);
                }
            }

            let resp = builder.send().await.map_err(|e| {
                let reason = if e.is_timeout() {
                    "соединение превысило таймаут (сервер не ответил вовремя)".to_string()
                } else if e.is_connect() {
                    "не удалось подключиться (сервер не запущен или порт закрыт)".to_string()
                } else {
                    e.to_string()
                };
                format!(
                    "Локальная модель недоступна: {}\n\nURL: {}\n\nПодсказки:\n• LM Studio: вкладка 'Local Server' → зелёная кнопка + модель выбрана\n• LM Studio → http://127.0.0.1:PORT  (не localhost!)\n• Ollama → http://127.0.0.1:11434",
                    reason, url
                )
            })?;

            let status = resp.status();
            // Read as text first so we get the raw body even if it's not valid JSON
            let body_text = resp.text().await.map_err(|e| e.to_string())?;

            if !status.is_success() {
                // Try to extract a human-readable message from various server formats
                let detail = serde_json::from_str::<Value>(&body_text).ok()
                    .and_then(|j| {
                        // OpenAI-compat: { error: { message: "..." } }
                        // LM Studio alt:  { message: "..." }
                        // FastAPI/Uvicorn: { detail: "..." }
                        j["error"]["message"].as_str()
                            .or_else(|| j["message"].as_str())
                            .or_else(|| j["detail"].as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| body_text.chars().take(300).collect());
                return Err(format!("Local LLM {}: {}", status, detail));
            }

            let json: Value = serde_json::from_str(&body_text)
                .map_err(|e| format!("Failed to parse response JSON: {}\nRaw: {}", e, &body_text.chars().take(200).collect::<String>()))?;

            Ok(AiResponse {
                text:        extract_content(&json),
                model:       json["model"].as_str().unwrap_or(model).to_string(),
                tokens_used: json["usage"]["total_tokens"].as_u64().map(|n| n as u32),
            })
        } => result,
        _ = cancel_rx.changed() => Err("__CANCELLED__".into()),
    }
}
// ═══════════════════════════════════════════════════════════════════════
// Universal SSE streaming
// Emits: "ai-stream-token" (delta string) and "ai-stream-done" ({text, model})
// ═══════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize)]
pub struct StreamRequest {
    pub provider:      String,
    pub api_key:       String,
    pub prompt:        String,
    pub system_prompt: Option<String>,
    pub image_base64:  Option<String>,
    pub context_files: Option<Vec<String>>,
    pub model:         Option<String>,
    pub max_tokens:    Option<u32>,
    pub local_url:     Option<String>,
}

#[tauri::command]
pub async fn analyze_stream(window: tauri::Window, req: StreamRequest) -> Result<(), String> {
    let mut cancel_rx = new_cancel_receiver();
    tokio::select! {
        result = stream_inner(window.clone(), req) => result,
        _ = cancel_rx.changed() => {
            let _ = window.emit("ai-stream-done", serde_json::json!({ "cancelled": true }));
            Err("__CANCELLED__".into())
        },
    }
}

async fn stream_inner(window: tauri::Window, req: StreamRequest) -> Result<(), String> {
    match req.provider.as_str() {
        "claude" => stream_claude(window, req).await,
        _        => stream_openai_compat(window, req).await,
    }
}

async fn stream_openai_compat(window: tauri::Window, req: StreamRequest) -> Result<(), String> {
    let client = http_client().map_err(|e| e.to_string())?;

    let (url, bearer) = match req.provider.as_str() {
        "openai"     => {
            if req.api_key.is_empty() { return Err("OpenAI API key required".into()); }
            ("https://api.openai.com/v1/chat/completions".to_string(), req.api_key.clone())
        }
        "deepseek"   => {
            if req.api_key.is_empty() { return Err("DeepSeek API key required".into()); }
            ("https://api.deepseek.com/v1/chat/completions".to_string(), req.api_key.clone())
        }
        "openrouter" => {
            if req.api_key.is_empty() { return Err("OpenRouter API key required".into()); }
            ("https://openrouter.ai/api/v1/chat/completions".to_string(), req.api_key.clone())
        }
        "local" => {
            let base = req.local_url.as_deref().unwrap_or("http://127.0.0.1:1234").trim_end_matches('/');
            let has_path = base.split("://").nth(1).map(|s| s.contains('/')).unwrap_or(false);
            let url = if has_path { base.to_string() } else { format!("{}/v1/chat/completions", base) };
            (url, req.api_key.clone())
        }
        other => return Err(format!("Unknown provider for streaming: {}", other)),
    };

    let model = req.model.as_deref().unwrap_or(match req.provider.as_str() {
        "deepseek"   => "deepseek-chat",
        "openrouter" => "openai/gpt-4o",
        "local"      => "local-model",
        _            => "gpt-4o",
    }).to_string();

    let ai_req = AiRequest {
        api_key: req.api_key.clone(), prompt: req.prompt.clone(),
        system_prompt: req.system_prompt.clone(), image_base64: req.image_base64.clone(),
        context_files: req.context_files.clone(), model: req.model.clone(), max_tokens: req.max_tokens,
    };
    let prompt_text = build_prompt(&ai_req);

    let mut messages: Vec<Value> = Vec::new();

    // For cloud providers, use a proper system message
    if req.provider != "local" {
        if let Some(sys) = &req.system_prompt {
            if !sys.trim().is_empty() {
                messages.push(json!({ "role": "system", "content": sys }));
            }
        }
    }

    // For local, prepend system to user message (many local servers reject "system" role)
    let full_user_text = if req.provider == "local" {
        if let Some(sys) = &req.system_prompt {
            let s = sys.trim();
            if !s.is_empty() { format!("{}\n\n{}", s, prompt_text) } else { prompt_text }
        } else { prompt_text }
    } else { prompt_text };

    let user_msg = if let Some(b64) = &req.image_base64 {
        json!({ "role": "user", "content": [
            { "type": "text",      "text": full_user_text },
            { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", b64) } }
        ]})
    } else {
        json!({ "role": "user", "content": full_user_text })
    };
    messages.push(user_msg);

    let max_tok = req.max_tokens.unwrap_or(4096);
    let body = json!({
        "model": model, "messages": messages,
        "max_tokens": max_tok, "stream": true
    });

    let mut builder = client.post(&url).json(&body);
    if !bearer.is_empty() { builder = builder.bearer_auth(&bearer); }
    if req.provider == "openrouter" {
        builder = builder
            .header("HTTP-Referer", "https://github.com/ai-assistant")
            .header("X-Title", "AI Assistant Overlay");
    }

    let resp = builder.send().await.map_err(|e| format!("Stream failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let err_json: Value = resp.json().await.unwrap_or(json!({}));
        return Err(format!("{} {}: {}", req.provider, status,
            err_json["error"]["message"].as_str().unwrap_or("unknown")));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full_text = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read: {}", e))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" { break; }
                if let Ok(j) = serde_json::from_str::<Value>(data) {
                    let delta = j["choices"][0]["delta"]["content"].as_str().unwrap_or("");
                    if !delta.is_empty() {
                        full_text.push_str(delta);
                        let _ = window.emit("ai-stream-token", delta);
                    }
                }
            }
        }
    }

    let _ = window.emit("ai-stream-done", serde_json::json!({ "text": full_text, "model": model }));
    Ok(())
}

async fn stream_claude(window: tauri::Window, req: StreamRequest) -> Result<(), String> {
    if req.api_key.is_empty() { return Err("Anthropic API key required".into()); }
    let client = http_client().map_err(|e| e.to_string())?;
    let model = req.model.as_deref().unwrap_or("claude-3-5-sonnet-20241022").to_string();

    let ai_req = AiRequest {
        api_key: req.api_key.clone(), prompt: req.prompt.clone(),
        system_prompt: req.system_prompt.clone(), image_base64: req.image_base64.clone(),
        context_files: req.context_files.clone(), model: req.model.clone(), max_tokens: req.max_tokens,
    };

    let mut content: Vec<Value> = Vec::new();
    if let Some(b64) = &req.image_base64 {
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } }));
    }
    content.push(json!({ "type": "text", "text": build_prompt(&ai_req) }));

    let sys = req.system_prompt.as_deref().unwrap_or("").trim();
    let max_tok = req.max_tokens.unwrap_or(4096);
    let mut body = json!({
        "model": model, "max_tokens": max_tok, "stream": true,
        "messages": [{ "role": "user", "content": content }]
    });
    if !sys.is_empty() { body["system"] = json!(sys); }

    let resp = client.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &req.api_key).header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json").json(&body)
        .send().await.map_err(|e| format!("Stream failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let err_json: Value = resp.json().await.unwrap_or(json!({}));
        return Err(format!("Claude {}: {}", status,
            err_json["error"]["message"].as_str().unwrap_or("unknown")));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full_text = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read: {}", e))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(j) = serde_json::from_str::<Value>(data) {
                    if j["type"] == "content_block_delta" {
                        let delta = j["delta"]["text"].as_str().unwrap_or("");
                        if !delta.is_empty() {
                            full_text.push_str(delta);
                            let _ = window.emit("ai-stream-token", delta);
                        }
                    }
                }
            }
        }
    }

    let _ = window.emit("ai-stream-done", serde_json::json!({ "text": full_text, "model": model }));
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Ollama / LM Studio — list local models + SD models
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn list_ollama_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    let base = base_url.as_deref().unwrap_or("http://127.0.0.1:11434").trim_end_matches('/');
    let client = http_client().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{}/api/tags", base))
        .timeout(std::time::Duration::from_secs(4)).send().await
        .map_err(|e| format!("Ollama not reachable at {}: {}", base, e))?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["models"].as_array().unwrap_or(&vec![])
        .iter().filter_map(|m| m["name"].as_str().map(String::from)).collect())
}

#[tauri::command]
pub async fn list_lmstudio_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    let base = base_url.as_deref().unwrap_or("http://127.0.0.1:1234").trim_end_matches('/');
    let client = http_client().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{}/v1/models", base))
        .timeout(std::time::Duration::from_secs(4)).send().await
        .map_err(|e| format!("LM Studio not reachable at {}: {}", base, e))?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["data"].as_array().unwrap_or(&vec![])
        .iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SdModel {
    pub title:      String,
    pub model_name: String,
}

#[tauri::command]
pub async fn list_sd_models(base_url: Option<String>) -> Result<Vec<SdModel>, String> {
    let base = base_url.as_deref().unwrap_or("http://127.0.0.1:7860").trim_end_matches('/');
    let client = http_client().map_err(|e| e.to_string())?;
    let resp = client.get(format!("{}/sdapi/v1/sd-models", base))
        .timeout(std::time::Duration::from_secs(8)).send().await
        .map_err(|e| format!("SD WebUI not reachable at {}: {}", base, e))?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json.as_array().unwrap_or(&vec![]).iter().map(|m| SdModel {
        title:      m["title"].as_str().unwrap_or("").to_string(),
        model_name: m["model_name"].as_str().unwrap_or("").to_string(),
    }).collect())
}