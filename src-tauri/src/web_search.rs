// web_search.rs — multi-backend web search + page-content fetcher for RAG
//
// Backends:
//   duckduckgo  — HTML scraping of html.duckduckgo.com (real results, no key)
//   brave       — Brave Search API (requires free API key)
//   searxng     — self-hosted SearXNG instance
//
// Extra commands:
//   fetch_url_content  — fetch a single URL and extract plain text
//   search_and_fetch   — search + parallel-fetch top-N pages for deep RAG

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use regex::Regex;
use std::time::Duration;

// ── Public types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub title:   String,
    pub url:     String,
    pub snippet: String,
    /// Full page text if content was fetched (may be None)
    pub content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WebSearchRequest {
    pub query:         String,
    pub backend:       String,
    pub api_key:       Option<String>,
    pub base_url:      Option<String>,
    pub max_results:   Option<usize>,
    /// Fetch page content for top results when true
    pub fetch_content: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WebSearchResponse {
    pub results: Vec<SearchResult>,
    pub backend: String,
    pub query:   String,
}

// ── HTTP clients ──────────────────────────────────────────────────────────

fn http_client() -> reqwest::Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        )
        .build()
}

fn http_client_page() -> reqwest::Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        )
        .build()
}

// ── Tauri commands ────────────────────────────────────────────────────────

/// Perform a web search, optionally also fetching page content.
#[tauri::command]
pub async fn web_search(req: WebSearchRequest) -> Result<WebSearchResponse, String> {
    let max   = req.max_results.unwrap_or(5).min(10);
    let fetch = req.fetch_content.unwrap_or(false);

    let mut resp = dispatch_search(&req.backend, &req.query, req.api_key.as_deref(),
                                   req.base_url.as_deref(), max).await?;

    if fetch && !resp.results.is_empty() {
        resp.results = fetch_results_content(resp.results, 3).await;
    }
    Ok(resp)
}

/// Fetch readable plain text from a single URL.
#[tauri::command]
pub async fn fetch_url_content(url: String, max_chars: Option<usize>) -> Result<String, String> {
    fetch_page_text(&url, max_chars.unwrap_or(4_000)).await
}

/// Search and automatically fetch page content for top 3 results in parallel.
#[tauri::command]
pub async fn search_and_fetch(req: WebSearchRequest) -> Result<WebSearchResponse, String> {
    let max = req.max_results.unwrap_or(5).min(10);
    let mut resp = dispatch_search(&req.backend, &req.query, req.api_key.as_deref(),
                                   req.base_url.as_deref(), max).await?;
    resp.results = fetch_results_content(resp.results, 3).await;
    Ok(resp)
}

// ── Dispatch ──────────────────────────────────────────────────────────────

async fn dispatch_search(
    backend: &str,
    query:   &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    max:     usize,
) -> Result<WebSearchResponse, String> {
    match backend {
        "brave"      => search_brave(query, api_key.unwrap_or(""), max).await,
        "searxng"    => search_searxng(query, base_url.unwrap_or("http://localhost:8080"), max).await,
        "duckduckgo" => search_duckduckgo(query, max).await,
        other        => Err(format!("Unknown search backend: {}", other)),
    }
}

// ── DuckDuckGo (HTML scrape + instant-answer fallback) ───────────────────

async fn search_duckduckgo(query: &str, max: usize) -> Result<WebSearchResponse, String> {
    match ddg_html_search(query, max).await {
        Ok(r) if !r.results.is_empty() => return Ok(r),
        Ok(_)  => log::warn!("DDG HTML returned 0 results, using instant-answer fallback"),
        Err(e) => log::warn!("DDG HTML error: {} — using instant-answer fallback", e),
    }
    ddg_instant_answer(query, max).await
}

async fn ddg_html_search(query: &str, max: usize) -> Result<WebSearchResponse, String> {
    let client = http_client().map_err(|e| e.to_string())?;

    // Use DDG Lite with GET — more browser-transparent than POST, avoids bot checks
    let url = format!(
        "https://lite.duckduckgo.com/lite/?q={}&kl=en-us",
        percent_encode_query(query)
    );
    let html = client
        .get(&url)
        .header("Accept",          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "identity")
        .header("Referer",         "https://lite.duckduckgo.com/")
        .send()
        .await
        .map_err(|e| format!("DuckDuckGo request failed: {}", e))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    Ok(WebSearchResponse {
        results: parse_ddg_lite_html(&html, max),
        backend: "duckduckgo".into(),
        query:   query.into(),
    })
}

/// Encode a query string for use in a URL query parameter.
fn percent_encode_query(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            c   => c.to_string().bytes().map(|b| format!("%{:02X}", b)).collect(),
        })
        .collect()
}

/// Parse DDG Lite HTML.
/// Works regardless of attribute order inside the <a> tag.
fn parse_ddg_lite_html(html: &str, max: usize) -> Vec<SearchResult> {
    let truncated = html
        .split_once("</body")
        .or_else(|| html.split_once("</BODY"))
        .map(|(s, _)| s)
        .unwrap_or(html);

    // Pass 1: find every <a> tag that contains class='result-link' or class="result-link"
    // Captures: (1) everything inside the <a …>, (2) the link title text
    let tag_re = Regex::new(
        r#"(?i)<a\s([^>]*(?:class=['"]result-link['"])[^>]*)>([^<]*)</a>"#
    ).unwrap();
    // DDG Lite wraps URLs in a redirect: href="//duckduckgo.com/l/?uddg=ENCODED_URL&..."
    // Extract the uddg= value and percent-decode it
    let uddg_re        = Regex::new(r#"uddg=([^&"'\s>]+)"#).unwrap();
    let href_direct_re = Regex::new(r#"href=["']?(https?://[^"'\s>]+)["']?"#).unwrap();

    let snippet_re = Regex::new(
        r"class='result-snippet'[^>]*>([\s\S]*?)</td>"
    ).unwrap();

    let snippets: Vec<String> = snippet_re
        .captures_iter(truncated)
        .map(|c| strip_html_tags(c.get(1).map(|m| m.as_str()).unwrap_or("")))
        .collect();

    let mut snippet_iter = snippets.into_iter();
    let mut results = Vec::new();

    for cap in tag_re.captures_iter(truncated) {
        if results.len() >= max { break; }
        let attrs = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let title = cap.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();

        // Try DDG redirect first, else direct URL
        let url = if let Some(m) = uddg_re.captures(attrs).and_then(|c| c.get(1)) {
            percent_decode(m.as_str())
        } else {
            href_direct_re.captures(attrs)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default()
        };

        if url.is_empty() || title.is_empty() { continue; }
        results.push(SearchResult { title, url, snippet: snippet_iter.next().unwrap_or_default(), content: None });
    }
    results
}

async fn ddg_instant_answer(query: &str, max: usize) -> Result<WebSearchResponse, String> {
    let client = http_client().map_err(|e| e.to_string())?;

    let resp: Value = client
        .get("https://api.duckduckgo.com/")
        .query(&[("q", query), ("format", "json"), ("no_html", "1"), ("skip_disambig", "1")])
        .send().await.map_err(|e| format!("DDG instant error: {}", e))?
        .json().await.map_err(|e| e.to_string())?;

    let mut results: Vec<SearchResult> = Vec::new();

    if let Some(text) = resp["AbstractText"].as_str() {
        if !text.is_empty() {
            results.push(SearchResult {
                title:   resp["Heading"].as_str().unwrap_or(query).to_string(),
                url:     resp["AbstractURL"].as_str().unwrap_or("").to_string(),
                snippet: text.to_string(),
                content: None,
            });
        }
    }

    if let Some(topics) = resp["RelatedTopics"].as_array() {
        for t in topics.iter().take(max.saturating_sub(results.len())) {
            if let (Some(text), Some(url)) = (t["Text"].as_str(), t["FirstURL"].as_str()) {
                results.push(SearchResult {
                    title:   url.split('/').last().unwrap_or("").replace('-', " ").to_string(),
                    url:     url.to_string(),
                    snippet: text.to_string(),
                    content: None,
                });
            }
        }
    }

    if results.is_empty() {
        return Err(
            "DuckDuckGo returned no results. Use Brave Search for reliable web coverage.".into(),
        );
    }

    Ok(WebSearchResponse { results, backend: "duckduckgo".into(), query: query.into() })
}

// ── Brave Search ─────────────────────────────────────────────────────────

async fn search_brave(query: &str, api_key: &str, max: usize) -> Result<WebSearchResponse, String> {
    if api_key.is_empty() {
        return Err("Brave Search requires an API key (free tier at brave.com/search/api)".into());
    }

    let client = http_client().map_err(|e| e.to_string())?;

    let resp: Value = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("Accept",          "application/json")
        .header("Accept-Encoding", "gzip")
        .header("X-Subscription-Token", api_key)
        .query(&[("q", query), ("count", &max.to_string()), ("search_lang", "en")])
        .send().await.map_err(|e| format!("Brave Search error: {}", e))?
        .json().await.map_err(|e| e.to_string())?;

    if let Some(msg) = resp["message"].as_str() {
        return Err(format!("Brave API error: {}", msg));
    }

    let results = resp["web"]["results"]
        .as_array().unwrap_or(&vec![])
        .iter().take(max)
        .map(|r| SearchResult {
            title:   r["title"].as_str().unwrap_or("").to_string(),
            url:     r["url"].as_str().unwrap_or("").to_string(),
            snippet: r["description"].as_str().unwrap_or("").to_string(),
            content: None,
        })
        .collect();

    Ok(WebSearchResponse { results, backend: "brave".into(), query: query.into() })
}

// ── SearXNG ──────────────────────────────────────────────────────────────

async fn search_searxng(query: &str, base_url: &str, max: usize) -> Result<WebSearchResponse, String> {
    let client = http_client().map_err(|e| e.to_string())?;
    let url = format!("{}/search", base_url.trim_end_matches('/'));

    let resp: Value = client
        .get(&url)
        .query(&[
            ("q",        query),
            ("format",   "json"),
            ("language", "en"),
            ("engines",  "google,bing,duckduckgo,brave"),
        ])
        .send().await
        .map_err(|e| format!("SearXNG error: {} — is the server running at {}?", e, base_url))?
        .json().await
        .map_err(|e| format!("SearXNG returned invalid JSON (non-JSON format?): {}", e))?;

    let results = resp["results"]
        .as_array().unwrap_or(&vec![])
        .iter().take(max)
        .map(|r| SearchResult {
            title:   r["title"].as_str().unwrap_or("").to_string(),
            url:     r["url"].as_str().unwrap_or("").to_string(),
            snippet: r["content"].as_str().unwrap_or("").to_string(),
            content: None,
        })
        .collect();

    Ok(WebSearchResponse { results, backend: "searxng".into(), query: query.into() })
}

// ── Page content fetcher ─────────────────────────────────────────────────

async fn fetch_page_text(url: &str, max_chars: usize) -> Result<String, String> {
    let client = http_client_page().map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml,text/plain")
        .send().await
        .map_err(|e| format!("Fetch failed for {}: {}", url, e))?;

    let ct = response.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Skip binary content
    if ct.contains("pdf") || ct.contains("image") || ct.contains("video") || ct.contains("audio") {
        return Err(format!("Skipped non-text content type: {}", ct));
    }

    let html = response.text().await.map_err(|e| e.to_string())?;

    let text = if ct.contains("json") { html } else { html_to_text(&html) };

    Ok(if text.chars().count() > max_chars {
        text.chars().take(max_chars).collect::<String>() + "\n[... truncated ...]"
    } else {
        text
    })
}

/// Fetch content for the first `fetch_n` results in parallel.
async fn fetch_results_content(mut results: Vec<SearchResult>, fetch_n: usize) -> Vec<SearchResult> {
    use tokio::task::JoinSet;
    let mut set: JoinSet<(usize, Result<String, String>)> = JoinSet::new();

    for (i, r) in results.iter().enumerate().take(fetch_n) {
        let url = r.url.clone();
        set.spawn(async move { (i, fetch_page_text(&url, 3_500).await) });
    }

    while let Some(Ok((idx, res))) = set.join_next().await {
        match res {
            Ok(text) if !text.is_empty() => { results[idx].content = Some(text); }
            Err(e) => log::debug!("Page fetch [{}]: {}", idx, e),
            _ => {}
        }
    }
    results
}

// ── HTML / text utilities ─────────────────────────────────────────────────

fn html_to_text(html: &str) -> String {
    // Drop script / style / nav / footer / header blocks entirely
    let junk_re = Regex::new(
        r"(?si)<(script|style|nav|header|footer|noscript|iframe|svg|aside)[^>]*>[\s\S]*?</\1>",
    ).unwrap();
    let s = junk_re.replace_all(html, " ");

    // Strip remaining tags
    let tag_re = Regex::new(r"<[^>]+>").unwrap();
    let s = tag_re.replace_all(&s, " ");

    let s = s
        .replace("&amp;",   "&")
        .replace("&lt;",    "<")
        .replace("&gt;",    ">")
        .replace("&quot;",  "\"")
        .replace("&#39;",   "'")
        .replace("&nbsp;",  " ")
        .replace("&#8211;", "–")
        .replace("&#8212;", "—");

    let ws_re = Regex::new(r"\s{2,}").unwrap();
    ws_re.replace_all(s.as_ref(), " ").trim().to_string()
}

fn strip_html_tags(s: &str) -> String {
    let re = Regex::new(r"<[^>]+>").unwrap();
    let out = re.replace_all(s, "");
    out .replace("&amp;",  "&")
        .replace("&lt;",   "<")
        .replace("&gt;",   ">")
        .replace("&quot;", "\"")
        .replace("&#39;",  "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

fn percent_decode(s: &str) -> String {
    let s = s.replace('+', " ");
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (
                (b[i+1] as char).to_digit(16),
                (b[i+2] as char).to_digit(16),
            ) {
                out.push((h * 16 + l) as u8 as char);
                i += 3;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}
