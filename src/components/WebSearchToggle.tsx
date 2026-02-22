import { useState } from "react";
import { useAssistantStore } from "../store/assistantStore";

export default function WebSearchToggle() {
  const {
    webSearchEnabled, setWebSearchEnabled,
    searchBackend,    setSearchBackend,
    searchApiKey,     setSearchApiKey,
    searxngUrl,       setSearxngUrl,
    fetchPageContent, setFetchPageContent,
    searchMaxResults, setSearchMaxResults,
  } = useAssistantStore();

  const [expanded, setExpanded] = useState(false);
  const [showKey,  setShowKey]  = useState(false);

  return (
    <div className="bg-white/5 rounded-xl overflow-hidden">
      {/* Header row with main toggle */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 text-xs font-medium text-white/60 hover:text-white transition-colors"
        >
          <span>🌐</span>
          <span>Web Search</span>
          {webSearchEnabled && (
            <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded text-[9px]">
              ● {searchBackend}
            </span>
          )}
        </button>

        {/* ON/OFF pill toggle */}
        <button
          onClick={() => setWebSearchEnabled(!webSearchEnabled)}
          className={[
            "relative w-9 h-5 rounded-full transition-colors duration-200",
            webSearchEnabled ? "bg-green-500" : "bg-white/20",
          ].join(" ")}
          title={webSearchEnabled ? "Web search ON — click to disable" : "Web search OFF — click to enable"}
        >
          <span
            className={[
              "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200",
              webSearchEnabled ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")}
          />
        </button>
      </div>

      {/* Expanded config */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Backend selector */}
          <div className="flex gap-1">
            {(["duckduckgo", "brave", "searxng"] as const).map((b) => (
              <button
                key={b}
                onClick={() => setSearchBackend(b)}
                className={[
                  "flex-1 py-1 rounded-lg text-[10px] font-semibold transition-colors",
                  searchBackend === b
                    ? "bg-green-600 text-white"
                    : "bg-white/10 text-white/50 hover:bg-white/20",
                ].join(" ")}
              >
                {b === "duckduckgo" ? "🦆 DDG" : b === "brave" ? "🦁 Brave" : "🔍 SearXNG"}
              </button>
            ))}
          </div>

          {/* Backend-specific config */}
          {searchBackend === "brave" && (
            <>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={searchApiKey}
                  onChange={(e) => setSearchApiKey(e.target.value)}
                  placeholder="Brave Search API key (free tier available)"
                  className="w-full bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px] pr-8
                    placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-white/35 hover:text-white/70 text-xs"
                  tabIndex={-1}
                >
                  {showKey ? "🙈" : "👁"}
                </button>
              </div>
              <p className="text-[9px] text-white/30">
                Free tier: 2 000 queries/month →{" "}
                <span className="text-green-300/60">brave.com/search/api</span>
              </p>
            </>
          )}

          {searchBackend === "searxng" && (
            <>
              <input
                type="text"
                value={searxngUrl}
                onChange={(e) => setSearxngUrl(e.target.value)}
                placeholder="http://localhost:8080"
                className="w-full bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px]
                  font-mono placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
              <p className="text-[9px] text-white/30">
                Self-hosted SearXNG. Quick start:{" "}
                <span className="text-green-300/60 font-mono">docker run -p 8080:8080 searxng/searxng</span>
              </p>
            </>
          )}

          {searchBackend === "duckduckgo" && (
            <p className="text-[9px] text-white/30">
              No API key needed. Uses HTML scraping for real web results.
              Enable “Fetch pages” below for deeper context.
            </p>
          )}

          {/* ─ Fetch page content toggle ─ */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-white/50">
              Fetch page content
              <span className="block text-[9px] text-white/25">Slower, but AI gets full text</span>
            </span>
            <button
              onClick={() => setFetchPageContent(!fetchPageContent)}
              className={[
                "relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0",
                fetchPageContent ? "bg-blue-500" : "bg-white/20",
              ].join(" ")}
              title="Fetch full page content for top results"
            >
              <span
                className={[
                  "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200",
                  fetchPageContent ? "translate-x-4" : "translate-x-0.5",
                ].join(" ")}
              />
            </button>
          </div>

          {/* ─ Result count ─ */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/50">Results</span>
            <div className="flex gap-1">
              {[3, 5, 8].map((n) => (
                <button
                  key={n}
                  onClick={() => setSearchMaxResults(n)}
                  className={[
                    "w-7 py-0.5 rounded text-[10px] font-semibold transition-colors",
                    searchMaxResults === n
                      ? "bg-blue-600 text-white"
                      : "bg-white/10 text-white/50 hover:bg-white/20",
                  ].join(" ")}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
