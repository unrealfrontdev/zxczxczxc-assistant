// image_gen.rs — AI image generation via multiple backends
//
// Backends:
//   dalle       — OpenAI DALL-E 3 (uses OpenAI API key)
//   stability   — Stability AI stable-image-core (v2beta REST)
//   together    — Together AI FLUX / SDXL (requires Together API key)
//   local_sd    — Local Automatic1111 / FORGE WebUI (no key, http://localhost:7860)
//   openrouter  — OpenRouter image generation (uses OpenRouter key)

use base64::{engine::general_purpose, Engine};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

// ── Public types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageGenRequest {
    /// The visual prompt describing the image
    pub prompt: String,
    /// "dalle" | "stability" | "together" | "local_sd" | "openrouter"
    pub provider: String,
    /// API key (not needed for local_sd)
    pub api_key: Option<String>,
    /// Model name override
    pub model: Option<String>,
    /// Base URL override (required for local_sd, optional for others)
    pub url: Option<String>,
    /// Image width in pixels (provider may round/clamp)
    pub width: Option<u32>,
    /// Image height in pixels
    pub height: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageGenResponse {
    /// Base64-encoded image bytes (no data: prefix)
    pub image_base64: String,
    /// Optional revised prompt returned by the provider (DALL-E 3)
    pub revised_prompt: Option<String>,
    /// "png" or "jpeg"
    pub format: String,
}

// ── HTTP client ───────────────────────────────────────────────────────────

fn http_client() -> reqwest::Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("ai-assistant/0.1")
        .build()
}

// ── Tauri command ─────────────────────────────────────────────────────────

/// Generate an image using the configured provider.
/// Returns base64-encoded PNG/JPEG without the data: URI prefix.
#[tauri::command]
pub async fn generate_image(req: ImageGenRequest) -> Result<ImageGenResponse, String> {
    match req.provider.as_str() {
        "dalle"      => dalle_generate(req).await,
        "stability"  => stability_generate(req).await,
        "together"   => together_generate(req).await,
        "local_sd"   => local_sd_generate(req).await,
        "openrouter" => openrouter_generate(req).await,
        other => Err(format!("Unknown image generation provider: {}", other)),
    }
}

// ── DALL-E 3 ─────────────────────────────────────────────────────────────

async fn dalle_generate(req: ImageGenRequest) -> Result<ImageGenResponse, String> {
    let key = req.api_key.as_deref().unwrap_or("").trim().to_string();
    if key.is_empty() {
        return Err("OpenAI API key required for DALL-E".into());
    }

    let model = req.model.as_deref().unwrap_or("dall-e-3");

    // DALL-E 3 supported sizes: 1024×1024, 1792×1024, 1024×1792
    let w = req.width.unwrap_or(1024);
    let h = req.height.unwrap_or(1024);
    let size = if w > h { "1792x1024" } else if h > w { "1024x1792" } else { "1024x1024" };

    let client = http_client().map_err(|e| e.to_string())?;
    let body = json!({
        "model": model,
        "prompt": req.prompt,
        "n": 1,
        "size": size,
        "response_format": "b64_json",
        "quality": "standard",
    });

    let resp = client
        .post("https://api.openai.com/v1/images/generations")
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DALL-E request failed: {}", e))?;

    let status = resp.status();
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let err = json["error"]["message"].as_str().unwrap_or("Unknown DALL-E error");
        return Err(format!("DALL-E {}: {}", status, err));
    }

    let b64 = json["data"][0]["b64_json"]
        .as_str()
        .ok_or("No image returned by DALL-E")?
        .to_string();

    let revised = json["data"][0]["revised_prompt"]
        .as_str()
        .map(|s| s.to_string());

    Ok(ImageGenResponse {
        image_base64: b64,
        revised_prompt: revised,
        format: "png".into(),
    })
}

// ── Stability AI (stable-image-core v2beta) ───────────────────────────────

async fn stability_generate(req: ImageGenRequest) -> Result<ImageGenResponse, String> {
    let key = req.api_key.as_deref().unwrap_or("").trim().to_string();
    if key.is_empty() {
        return Err("Stability AI API key required".into());
    }

    let client = http_client().map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("prompt", req.prompt.clone())
        .text("output_format", "png");

    let resp = client
        .post("https://api.stability.ai/v2beta/stable-image/generate/core")
        .header("Authorization", format!("Bearer {}", key))
        .header("Accept", "image/*")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Stability AI request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Stability AI {}: {}", status, text));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(&bytes);

    Ok(ImageGenResponse {
        image_base64: b64,
        revised_prompt: None,
        format: "png".into(),
    })
}

// ── Together AI (Flux / Black Forest Labs) ────────────────────────────────

async fn together_generate(req: ImageGenRequest) -> Result<ImageGenResponse, String> {
    let key = req.api_key.as_deref().unwrap_or("").trim().to_string();
    if key.is_empty() {
        return Err("Together AI API key required".into());
    }

    // Default free Flux model; user can override via model field
    let model = req
        .model
        .as_deref()
        .unwrap_or("black-forest-labs/FLUX.1-schnell-Free");
    let width  = req.width.unwrap_or(1024);
    let height = req.height.unwrap_or(1024);

    let client = http_client().map_err(|e| e.to_string())?;
    let body = json!({
        "model": model,
        "prompt": req.prompt,
        "width":  width,
        "height": height,
        "steps":  4,
        "n":      1,
        "response_format": "b64_json",
    });

    let resp = client
        .post("https://api.together.xyz/v1/images/generations")
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Together AI request failed: {}", e))?;

    let status = resp.status();
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let json_str = json.to_string();
        let err = json["error"]["message"]
            .as_str()
            .unwrap_or(&json_str);
        return Err(format!("Together AI {}: {}", status, err));
    }

    let b64 = json["data"][0]["b64_json"]
        .as_str()
        .ok_or("No image returned by Together AI")?
        .to_string();

    Ok(ImageGenResponse {
        image_base64: b64,
        revised_prompt: None,
        format: "jpeg".into(),
    })
}

// ── OpenRouter image generation ───────────────────────────────────────────

async fn openrouter_generate(req: ImageGenRequest) -> Result<ImageGenResponse, String> {
    let key = req.api_key.as_deref().unwrap_or("").trim().to_string();
    if key.is_empty() {
        return Err("OpenRouter API key required".into());
    }

    // Default: FLUX.1.1 Pro via OpenRouter
    let model = req
        .model
        .as_deref()
        .unwrap_or("black-forest-labs/flux-1.1-pro");

    let client = http_client().map_err(|e| e.to_string())?;
    let body = json!({
        "model": model,
        "prompt": req.prompt,
    });

    let resp = client
        .post("https://openrouter.ai/api/v1/images/generations")
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {}", e))?;

    let status = resp.status();
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let json_str = json.to_string();
        let err = json["error"]["message"]
            .as_str()
            .unwrap_or(&json_str);
        return Err(format!("OpenRouter {}: {}", status, err));
    }

    // OpenRouter returns a URL; fetch it and encode as base64
    let url = json["data"][0]["url"]
        .as_str()
        .ok_or("No image URL returned by OpenRouter")?;

    let img_resp = http_client()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch image from OpenRouter URL: {}", e))?;

    let bytes = img_resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(&bytes);

    Ok(ImageGenResponse {
        image_base64: b64,
        revised_prompt: None,
        format: "png".into(),
    })
}

// ── Local Automatic1111 / Forge WebUI ────────────────────────────────────

async fn local_sd_generate(req: ImageGenRequest) -> Result<ImageGenResponse, String> {
    let base_url = req
        .url
        .as_deref()
        .unwrap_or("http://127.0.0.1:7860")
        .trim_end_matches('/')
        .to_string();

    let width  = req.width.unwrap_or(512);
    let height = req.height.unwrap_or(512);

    let client = http_client().map_err(|e| e.to_string())?;
    let body = json!({
        "prompt":            req.prompt,
        "negative_prompt":   "blurry, low quality, distorted, deformed",
        "steps":             25,
        "cfg_scale":         7,
        "width":             width,
        "height":            height,
        "sampler_name":      "DPM++ 2M Karras",
        "save_images":       false,
        "send_images":       true,
    });

    let resp = client
        .post(format!("{}/sdapi/v1/txt2img", base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Cannot reach local SD server at {} — {}.\n\
                 Make sure Automatic1111/Forge is running with --api flag.",
                base_url, e
            )
        })?;

    let status = resp.status();
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Local SD {}: {}", status, json));
    }

    let raw = json["images"][0]
        .as_str()
        .ok_or("No images array in SD response")?;

    // A1111 sometimes prefixes the base64 with "data:image/png;base64,"
    let b64 = raw
        .trim_start_matches("data:image/png;base64,")
        .trim_start_matches("data:image/jpeg;base64,")
        .to_string();

    Ok(ImageGenResponse {
        image_base64: b64,
        revised_prompt: None,
        format: "png".into(),
    })
}
