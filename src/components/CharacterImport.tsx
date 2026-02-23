/**
 * CharacterImport — import SillyTavern / chub.ai character cards from PNG.
 *
 * PNG character cards store their data in a tEXt chunk with keyword "chara",
 * where the value is base64-encoded JSON following the Character Card V2 spec.
 *
 * Import flow:
 *   1. User clicks "Import PNG"
 *   2. Tauri file dialog opens (filters *.png)
 *   3. File is read as binary bytes via Tauri fs API
 *   4. We parse the tEXt "chara" chunk in TypeScript (no Rust needed)
 *   5. Character is added to the store with the avatar extracted from the PNG
 *   6. User selects a character to activate it as the system prompt
 */
import { useState } from "react";
import { readBinaryFile } from "@tauri-apps/api/fs";
import { openFileSafe } from "../utils/dialog";
import {
  useAssistantStore,
  CharacterCard,
  extractCharaFromPng,
  parseCharacterCardJson,
} from "../store/assistantStore";
import StFormatText, { ST_FORMAT_EXAMPLES } from "./StFormatText";

export default function CharacterImport() {
  const {
    characters, activeCharacterId,
    addCharacter, deleteCharacter, setActiveCharacter,
  } = useAssistantStore();

  const [expanded,     setExpanded]     = useState(false);
  const [importing,    setImporting]    = useState(false);
  const [importError,  setImportError]  = useState<string | null>(null);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // ── Import a PNG card ─────────────────────────────────────────────────

  const handleImport = async () => {
    setImportError(null);
    const selected = await openFileSafe({
      title:    "Import character card (PNG)",
      filters:  [{ name: "PNG character card", extensions: ["png"] }],
      multiple: true,
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;

    setImporting(true);
    let imported = 0;
    const errors: string[] = [];

    for (const filePath of paths) {
      try {
        const bytes:  Uint8Array   = await readBinaryFile(filePath);
        const buffer: ArrayBuffer  = bytes.buffer;

        // ── Extract character JSON ──────────────────────────────
        const charaB64 = extractCharaFromPng(buffer);
        if (!charaB64) {
          errors.push(`${filePath}: no "chara" tEXt chunk found — not a valid character card PNG`);
          continue;
        }
        const json     = JSON.parse(atob(charaB64));
        const parsed   = parseCharacterCardJson(json);

        // ── Extract avatar (the PNG itself becomes the avatar) ──
        const avatarBase64 = uint8ToBase64(bytes);

        const card: CharacterCard = {
          ...parsed,
          id:           crypto.randomUUID(),
          avatarBase64,
          importedAt:   Date.now(),
        };
        addCharacter(card);
        imported++;
      } catch (err) {
        errors.push(`${filePath}: ${String(err)}`);
      }
    }

    setImporting(false);
    if (errors.length > 0) setImportError(errors.join("\n"));
    if (imported > 0) { setExpanded(true); }
  };

  const activeChar = characters.find((c) => c.id === activeCharacterId);

  return (
    <div className="bg-white/5 rounded-xl overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 text-xs font-medium text-white/60
            hover:text-white transition-colors min-w-0"
        >
          <span>🎭</span>
          <span className="shrink-0">Characters</span>
          {characters.length > 0 && (
            <span className="bg-pink-500/30 text-pink-300 px-1.5 py-0.5 rounded-full text-[9px] shrink-0">
              {characters.length}
            </span>
          )}
          {activeChar && (
            <span className="text-[9px] text-green-400/80 font-mono truncate max-w-[80px]">
              ▶ {activeChar.name}
            </span>
          )}
        </button>

        <button
          onClick={handleImport}
          disabled={importing}
          title="Import character card PNG (chub.ai / SillyTavern)"
          className="shrink-0 text-[10px] bg-pink-500/20 hover:bg-pink-500/40 text-pink-300
            px-2 py-1 rounded transition-colors disabled:opacity-50"
        >
          {importing ? "⚙️" : "+ Import PNG"}
        </button>
      </div>

      {/* Error */}
      {importError && (
        <p className="px-3 pb-2 text-[9px] text-red-400 whitespace-pre-wrap">{importError}</p>
      )}

      {/* ── Expanded body ──────────────────────────────────────────── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {characters.length === 0 && (
            <p className="text-[10px] text-white/25 text-center py-3">
              No characters imported. Download a character PNG from{" "}
              <span className="text-pink-400/60">chub.ai</span> and click "+ Import PNG".
            </p>
          )}

          {/* None / deactivate button */}
          {activeCharacterId && (
            <button
              onClick={() => setActiveCharacter(null)}
              className="w-full text-[10px] bg-white/5 hover:bg-white/10 text-white/40
                hover:text-white/70 py-1 rounded-lg transition-colors"
            >
              ✕ Deactivate character
            </button>
          )}

          {characters.map((char) => (
            <CharCard
              key={char.id}
              char={char}
              isActive={char.id === activeCharacterId}
              isExpanded={expandedCard === char.id}
              onToggleExpand={() => setExpandedCard((id) => id === char.id ? null : char.id)}
              onActivate={() =>
                setActiveCharacter(char.id === activeCharacterId ? null : char.id)
              }
              onDelete={() => deleteCharacter(char.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── CharCard ───────────────────────────────────────────────────────────────

interface CharCardProps {
  char:          CharacterCard;
  isActive:      boolean;
  isExpanded:    boolean;
  onToggleExpand: () => void;
  onActivate:    () => void;
  onDelete:      () => void;
}

function CharCard({ char, isActive, isExpanded, onToggleExpand, onActivate, onDelete }: CharCardProps) {
  const [showTips, setShowTips] = useState(false);

  const handleActivate = () => {
    const willActivate = !isActive;
    onActivate();
    if (willActivate) setShowTips(true);
    else setShowTips(false);
  };
  return (
    <div
      className={[
        "rounded-lg border transition-colors overflow-hidden",
        isActive
          ? "border-green-500/40 bg-green-500/10"
          : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]",
      ].join(" ")}
    >
      {/* Row */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        {/* Avatar */}
        {char.avatarBase64 ? (
          <img
            src={`data:image/png;base64,${char.avatarBase64}`}
            alt={char.name}
            className="w-8 h-8 rounded-full object-cover border border-white/10 shrink-0"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center
            text-xs shrink-0">
            🎭
          </div>
        )}

        {/* Name + desc */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-white/80 truncate">{char.name}</p>
          {char.description && (
            <p className="text-[9px] text-white/35 truncate">{char.description}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-1 shrink-0">
          <button
            onClick={onToggleExpand}
            title="Show details"
            className="text-[9px] text-white/30 hover:text-white/70 px-1 py-0.5 rounded"
          >
            {isExpanded ? "▲" : "▼"}
          </button>
          <button
            onClick={handleActivate}
            title={isActive ? "Deactivate" : "Activate as system prompt"}
            className={[
              "text-[9px] px-1.5 py-0.5 rounded transition-colors",
              isActive
                ? "bg-green-500/30 text-green-300 hover:bg-red-500/30 hover:text-red-300"
                : "bg-white/10 text-white/40 hover:bg-green-500/30 hover:text-green-300",
            ].join(" ")}
          >
            {isActive ? "✓ Active" : "Use"}
          </button>
          <button
            onClick={onDelete}
            title="Delete"
            className="text-[9px] text-white/20 hover:text-red-400 px-1 py-0.5 rounded"
          >
            🗑
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-2 pb-2 space-y-1 text-[9px] text-white/50 border-t border-white/[0.06]
          pt-1.5 max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          {char.system_prompt && (
            <Field label="System Prompt" value={char.system_prompt} />
          )}
          {char.personality && (
            <Field label="Personality" value={char.personality} />
          )}
          {char.scenario && (
            <Field label="Scenario" value={char.scenario} />
          )}
          {char.first_mes && (
            <Field label="First message" value={char.first_mes} />
          )}
        </div>
      )}

      {/* ── Formatting tips (shown after activation) ─────────────── */}
      {isActive && showTips && (
        <div className="border-t border-pink-500/20 bg-pink-950/30 px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-semibold text-pink-300/80 uppercase tracking-wider">
              💬 Roleplay formatting
            </p>
            <button
              onClick={() => setShowTips(false)}
              className="text-[9px] text-white/25 hover:text-white/60"
            >
              ✕
            </button>
          </div>
          <p className="text-[9px] text-white/40 leading-relaxed">
            You can separate dialogue, actions and OOC notes using these styles:
          </p>
          <div className="space-y-1.5">
            {ST_FORMAT_EXAMPLES.map((ex) => (
              <div key={ex.label} className="flex items-start gap-2">
                <code className={`text-[9px] font-mono shrink-0 ${ex.color}`}>{ex.label}</code>
                <div className="space-y-0.5">
                  <p className="text-[9px] text-white/30">{ex.description}</p>
                  <div className="text-[9px] text-white/50 font-mono">
                    <span className="text-white/20">e.g. </span>
                    <StFormatText text={ex.syntax} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-white/25 italic">
            Use the insert buttons below the chat input for quick formatting.
          </p>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[8px] uppercase tracking-wider text-white/25 mb-0.5">{label}</p>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{value}</p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert Uint8Array to base64 without hitting the stack limit on large buffers */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
