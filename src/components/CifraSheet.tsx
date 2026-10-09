import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CifraResult, CifraBlock } from "../lib/chords";
import type { ChordChartLine } from "../lib/lyrics";
import { RhythmMetronome } from "../lib/metronome";
import { transposeChordLine, transposeNote } from "../lib/transpose";

interface CifraSheetProps {
  cifra?: CifraResult | null;
  chordChart?: ChordChartLine[] | null;
  plainText?: string | null;
  detectedKey?: string | null;
  detectedBpm?: number | null;
  songTitle?: string;
  artistName?: string;
  onDownloadTxt?: () => void;
  onDownloadLrc?: () => void;
  hasLrc?: boolean;
}

export function CifraSheet({
  cifra,
  chordChart,
  plainText,
  detectedKey,
  detectedBpm,
  songTitle,
  artistName,
  onDownloadTxt,
  onDownloadLrc,
  hasLrc,
}: CifraSheetProps) {
  const [semitones, setSemitones] = useState(0);
  const [fontSize, setFontSize] = useState(15);
  const [showTabs, setShowTabs] = useState(false);
  const [isMetronomeActive, setIsMetronomeActive] = useState(false);
  const [activeBeatIndex, setActiveBeatIndex] = useState(-1);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const metronomeRef = useRef<RhythmMetronome | null>(null);

  // Initialize metronome
  useEffect(() => {
    const metro = new RhythmMetronome((step) => {
      setActiveBeatIndex(step);
    });
    metronomeRef.current = metro;
    return () => {
      metro.dispose();
      metronomeRef.current = null;
    };
  }, []);

  // Auto-scroll loop
  useEffect(() => {
    if (!autoScroll) return;
    const interval = window.setInterval(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop += scrollSpeed;
      }
    }, 40);
    return () => window.clearInterval(interval);
  }, [autoScroll, scrollSpeed]);

  // Key / Tom computation
  const baseKey = useMemo(() => {
    if (cifra?.key) return cifra.key;
    if (detectedKey) {
      // Labels vem do analisador em pt-BR ("G maior", "Am menor") ou ingles.
      const match = detectedKey.trim().match(/^([A-G][#b]?)\s*(maior|major|menor|minor)?/i);
      if (match) {
        const isMinor = /menor|minor/i.test(match[2] ?? "");
        return isMinor ? `${match[1]}m` : match[1];
      }
    }
    return "C";
  }, [cifra?.key, detectedKey]);

  const currentKey = useMemo(() => {
    return transposeNote(baseKey, semitones);
  }, [baseKey, semitones]);

  // Strumming rhythm details
  const strumming = useMemo(() => {
    if (cifra?.strummings && cifra.strummings.length > 0) {
      return cifra.strummings[0];
    }
    // Default rhythm if not provided by Cifra Club
    const bpm = detectedBpm ? Math.round(detectedBpm) : 90;
    return {
      section: "Ritmo Padrão",
      bpm,
      timeSignature: ["1", "x", "2", "x", "3", "x", "4", "x"],
      pattern: [7, 23, 7, 19, 23, 19, 7, 19],
      arrows: "↓   ↓ ↑   ↑ ↓ ↑",
      beats: "1 · 2 · 3 · 4 ·",
    };
  }, [cifra?.strummings, detectedBpm]);

  // Metronome toggle
  const toggleMetronome = useCallback(() => {
    if (!metronomeRef.current) return;
    if (isMetronomeActive) {
      metronomeRef.current.stop();
      setIsMetronomeActive(false);
    } else {
      metronomeRef.current.start(strumming.bpm ?? 90, strumming.pattern);
      setIsMetronomeActive(true);
    }
  }, [isMetronomeActive, strumming]);

  // Transpose handlers
  const handleTransposeDown = useCallback(() => {
    setSemitones((prev) => (prev <= -11 ? 0 : prev - 1));
  }, []);

  const handleTransposeUp = useCallback(() => {
    setSemitones((prev) => (prev >= 11 ? 0 : prev + 1));
  }, []);

  const handleResetTranspose = useCallback(() => {
    setSemitones(0);
  }, []);

  // Format lines for rendering
  const renderedContent = useMemo(() => {
    // 1. Cifra Club blocks
    if (cifra && cifra.blocks && cifra.blocks.length > 0) {
      return cifra.blocks.map((block: CifraBlock, index: number) => {
        if (block.type === "tab") {
          if (!showTabs) return null;
          return (
            <div key={index} className="cifra-block cifra-tab-block">
              <pre className="cifra-tab-pre">{block.text}</pre>
            </div>
          );
        }

        if (block.type === "section") {
          const title = block.title || block.text;
          return (
            <div key={index} className="cifra-block cifra-section-block">
              <span className="cifra-section-tag">
                {title.startsWith("[") ? title : `[${title}]`}
              </span>
            </div>
          );
        }

        if (block.type === "intro") {
          const transposedChords = transposeChordLine(block.chords || "", semitones);
          return (
            <div key={index} className="cifra-block cifra-intro-block">
              <span className="cifra-chord-row">{transposedChords}</span>
            </div>
          );
        }

        // Standard verse pair: chords line and lyrics line
        const transposedChords = block.chords
          ? transposeChordLine(block.chords, semitones)
          : null;

        return (
          <div key={index} className="cifra-block cifra-verse-block">
            {transposedChords && (
              <div className="cifra-chord-row">{transposedChords}</div>
            )}
            {block.text && (
              <div className="cifra-lyrics-row">{block.text}</div>
            )}
          </div>
        );
      });
    }

    // 2. Audio chord chart (chords over lyrics)
    if (chordChart && chordChart.length > 0) {
      return chordChart.map((line, index) => {
        const transposedChords = line.chords
          ? transposeChordLine(line.chords, semitones)
          : "";

        return (
          <div key={index} className="cifra-block cifra-verse-block">
            {transposedChords.trim() && (
              <div className="cifra-chord-row">{transposedChords}</div>
            )}
            <div className="cifra-lyrics-row">{line.text || "\u00A0"}</div>
          </div>
        );
      });
    }

    // 3. Plain lyrics fallback
    if (plainText) {
      const lines = plainText.split("\n");
      return lines.map((line, index) => {
        const trimmed = line.trim();
        if (/^\s*\[[^\]]+\]\s*$/.test(trimmed)) {
          return (
            <div key={index} className="cifra-block cifra-section-block">
              <span className="cifra-section-tag">{trimmed}</span>
            </div>
          );
        }
        return (
          <div key={index} className="cifra-block cifra-verse-block">
            <div className="cifra-lyrics-row">{line || "\u00A0"}</div>
          </div>
        );
      });
    }

    return null;
  }, [cifra, chordChart, plainText, semitones, showTabs]);

  // Plain text generator for copy / download
  const fullExportText = useMemo(() => {
    const lines: string[] = [];
    if (songTitle) {
      lines.push(`${songTitle}${artistName ? ` - ${artistName}` : ""}`);
      lines.push("");
    }
    lines.push(`Tom: ${currentKey}`);
    lines.push("");
    lines.push(`[${strumming.section}] ${strumming.bpm ? `${strumming.bpm} bpm` : ""}`);
    if (strumming.arrows) lines.push(strumming.arrows);
    if (strumming.beats) lines.push(strumming.beats);
    lines.push("");

    if (cifra && cifra.blocks) {
      for (const block of cifra.blocks) {
        if (block.type === "section") {
          lines.push(block.title || block.text);
          lines.push("");
        } else if (block.type === "tab") {
          if (showTabs) {
            lines.push(block.text);
            lines.push("");
          }
        } else if (block.type === "intro") {
          lines.push(transposeChordLine(block.chords || "", semitones));
          lines.push("");
        } else {
          if (block.chords) {
            lines.push(transposeChordLine(block.chords, semitones));
          }
          if (block.text) {
            lines.push(block.text);
          }
          lines.push("");
        }
      }
    } else if (chordChart) {
      for (const line of chordChart) {
        if (line.chords.trim()) {
          lines.push(transposeChordLine(line.chords, semitones));
        }
        lines.push(line.text);
        lines.push("");
      }
    } else if (plainText) {
      lines.push(plainText);
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }, [cifra, chordChart, currentKey, plainText, semitones, showTabs, strumming]);

  // Copy to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(fullExportText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [fullExportText]);

  // Check if tabs exist
  const hasTabs = useMemo(() => {
    return cifra?.blocks?.some((b) => b.type === "tab") ?? false;
  }, [cifra]);

  return (
    <div className="cifra-model-container">
      {/* Top Header / Metadata Bar */}
      <div className="cifra-meta-header">
        <div className="cifra-meta-left">
          {/* Tone / Key Indicator */}
          <div className="cifra-tone-control" title="Tom da música">
            <span className="cifra-tone-label">Tom:</span>
            <span className="cifra-tone-val">{currentKey}</span>
            <div className="cifra-transpose-btns">
              <button
                type="button"
                className="cifra-mini-btn"
                onClick={handleTransposeDown}
                title="Diminuir meio tom (♭)"
              >
                -
              </button>
              {semitones !== 0 && (
                <button
                  type="button"
                  className="cifra-mini-btn cifra-mini-reset"
                  onClick={handleResetTranspose}
                  title="Restaurar tom original"
                >
                  {semitones > 0 ? `+${semitones}` : semitones}
                </button>
              )}
              <button
                type="button"
                className="cifra-mini-btn"
                onClick={handleTransposeUp}
                title="Aumentar meio tom (♯)"
              >
                +
              </button>
            </div>
          </div>

          {/* Strumming / Rhythm Widget */}
          <div className="cifra-rhythm-widget">
            <button
              type="button"
              className={`cifra-play-rhythm-btn ${isMetronomeActive ? "is-playing" : ""}`}
              onClick={toggleMetronome}
              title={isMetronomeActive ? "Pausar ritmo" : "Ouvir batida (ritmo com metrônomo)"}
            >
              {isMetronomeActive ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <span className="cifra-rhythm-section">[{strumming.section}]</span>
            <span className="cifra-bpm-badge">{strumming.bpm ?? 90} bpm</span>
          </div>
        </div>

        {/* Toolbar: Font Size, Auto-scroll, Tabs, Copy, Download */}
        <div className="cifra-meta-right">
          <div className="cifra-tool-group">
            <button
              type="button"
              className="cifra-action-btn"
              onClick={() => setFontSize((s) => Math.max(12, s - 1))}
              title="Diminuir tamanho da letra"
            >
              A-
            </button>
            <button
              type="button"
              className="cifra-action-btn"
              onClick={() => setFontSize((s) => Math.min(22, s + 1))}
              title="Aumentar tamanho da letra"
            >
              A+
            </button>
          </div>

          {hasTabs && (
            <button
              type="button"
              className={`cifra-action-btn ${showTabs ? "is-active" : ""}`}
              onClick={() => setShowTabs((t) => !t)}
              title={showTabs ? "Ocultar tablaturas de guitarra" : "Exibir tablaturas de guitarra"}
            >
              {showTabs ? "Ocultar tabs" : "Exibir tabs"}
            </button>
          )}

          <button
            type="button"
            className={`cifra-action-btn ${autoScroll ? "is-active" : ""}`}
            onClick={() => setAutoScroll((a) => !a)}
            title={autoScroll ? "Pausar rolagem automática" : "Rolar automaticamente para tocar"}
          >
            {autoScroll ? "Rolando..." : "Rolar"}
          </button>

          {autoScroll && (
            <select
              className="cifra-speed-select"
              value={scrollSpeed}
              onChange={(e) => setScrollSpeed(Number(e.target.value))}
              title="Velocidade de rolagem"
            >
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="3">3x</option>
            </select>
          )}

          <button
            type="button"
            className="cifra-action-btn"
            onClick={handleCopy}
            title="Copiar cifra completa para área de transferência"
          >
            {copied ? "Copiado!" : "Copiar"}
          </button>
        </div>
      </div>

      {/* Strumming Pattern Arrows Display (Matching the image) */}
      <div className="cifra-strum-pattern-box">
        <div className="cifra-arrows-line">
          {strumming.arrows.split("").map((char, i) => (
            <span
              key={i}
              className={`cifra-arrow-char ${
                activeBeatIndex >= 0 && i === activeBeatIndex * 2 ? "active-beat" : ""
              }`}
            >
              {char}
            </span>
          ))}
        </div>
        <div className="cifra-beats-line">
          {strumming.beats.split("").map((char, i) => (
            <span
              key={i}
              className={`cifra-beat-char ${
                activeBeatIndex >= 0 && i === activeBeatIndex * 2 ? "active-beat" : ""
              }`}
            >
              {char}
            </span>
          ))}
        </div>
      </div>

      {/* Main Cifra Monospace Body */}
      <div
        ref={containerRef}
        className="cifra-sheet-body"
        style={{ fontSize: `${fontSize}px` }}
      >
        {renderedContent}
      </div>

      {/* Footer Actions */}
      <div className="cifra-footer-actions">
        {onDownloadTxt && (
          <button type="button" className="btn btn-ghost" onClick={onDownloadTxt}>
            Baixar cifra (.txt)
          </button>
        )}
        {hasLrc && onDownloadLrc && (
          <button type="button" className="btn btn-ghost" onClick={onDownloadLrc}>
            Baixar sincronizada (.lrc)
          </button>
        )}
      </div>
    </div>
  );
}
