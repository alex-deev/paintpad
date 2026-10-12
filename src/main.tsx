import { StrictMode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PALETTE, normalizeHex, readableTextOn } from "./canvas/color";
import { Engine } from "./canvas/engine";
import { decode, encode } from "./canvas/serialize";
import { clearDocument, flushSave, loadDocument, saveDocument } from "./canvas/storage";
import type { ToolId } from "./canvas/record";
import "./styles.css";

type Slot = "foreground" | "background";

const TOOLS: { id: ToolId; key: string }[] = [
  { id: "pencil", key: "1" },
  { id: "eraser", key: "2" },
  { id: "line", key: "3" },
  { id: "rect", key: "4" },
  { id: "ellipse", key: "5" },
  { id: "fill", key: "6" },
  { id: "select", key: "7" },
];

const RECENTS_KEY = "paintpad.recents";

/** Autosave debounce. Long enough to coalesce a gesture, short enough to lose almost nothing. */
const SAVE_DEBOUNCE_MS = 400;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && normalizeHex(v) === v);
  } catch {
    // A corrupt or unavailable store must never stop the editor from loading.
    return [];
  }
}

/**
 * Minimal dev harness for the render engine. Deliberately unstyled — this slice is about
 * pixels, not design. The real UI shell lands in a later slice.
 */
function App() {
  // Lazy initialiser: the engine is created during render, not in an effect, so React 19's
  // StrictMode double-invoke cannot leave a half-attached engine or leak listeners.
  const [engine] = useState(() => new Engine());

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [slot, setSlot] = useState<Slot>("foreground");
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [hexDraft, setHexDraft] = useState("");
  const [hexError, setHexError] = useState(false);
  // Boot is asynchronous now: the autosave is read before the engine is attached, so the
  // raster is sized to the saved document. The canvas stays hidden until that finishes,
  // because a visible canvas that has not had its pointer handlers wired up yet is a lie —
  // it would accept clicks and paint nothing.
  const [ready, setReady] = useState(false);

  const settings = useSyncExternalStore(
    (onChange) => engine.subscribe(() => onChange()),
    () => engine.settings(),
    () => engine.settings(),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    // Autosave loads the command log, not a raster, so the document comes back by replaying
    // exactly the path live drawing took. Everything here is best-effort: a corrupt save, an
    // unreadable store, or storage disabled outright all resolve to "start clean", because a
    // failed save must never stop the app from drawing.
    void (async () => {
      const saved = await loadDocument()
        .then((raw) => (raw === null ? null : decode(raw)))
        .catch(() => null);
      if (disposed) return;

      engine.attach(canvas, stage);
      if (saved) engine.restore(saved);
      setReady(true);

      const observer = new ResizeObserver(() => {
        engine.setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
      });
      observer.observe(stage);

      // Persist on document changes only — not on zoom, tool, or colour selection, which do
      // not alter the log. Debounced so a stroke with many pointer samples is not serialised
      // repeatedly.
      let timer: ReturnType<typeof setTimeout> | null = null;
      let lastSaved: string | null = null;

      const write = () => {
        // Zoom, pan and tool changes all emit, but do not alter the document. Comparing the
        // encoded form keeps those from rewriting an identical save.
        const json = encode(engine.documentState());
        if (json === lastSaved) return;
        lastSaved = json;
        void saveDocument(json).catch(() => {});
      };

      const scheduleSave = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          write();
        }, SAVE_DEBOUNCE_MS);
      };

      // The debounce has a cost: without this, closing the tab within SAVE_DEBOUNCE_MS of the
      // last stroke would lose exactly that stroke — the one failure autosave exists to
      // prevent.
      //
      // This is deliberately unconditional, and gated on nothing. An earlier version skipped
      // the flush when no debounce was pending, reasoning that the write had already gone
      // out. It had — but an IndexedDB transaction begun moments before unload does not
      // commit, so the skip lost the stroke anyway. `lastSaved` records what was *attempted*,
      // never what is durable, and it must not be used to justify skipping here.
      //
      // `flushSave` is synchronous precisely because of that: `localStorage.setItem` always
      // completes, so this write cannot be lost to the unload it is reacting to.
      const flush = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        const json = encode(engine.documentState());
        lastSaved = json;
        flushSave(json);
        void saveDocument(json).catch(() => {});
      };

      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") flush();
      };

      const unsubscribe = engine.subscribe(scheduleSave);
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("pagehide", flush);

      // Expose for Playwright goldens and manual poking. Gated so a shipped build does not
      // leak internals; the e2e suite runs against the dev server, where this is true.
      if (import.meta.env.DEV) {
        (window as unknown as { __paintpad: Engine }).__paintpad = engine;
      }

      cleanup = () => {
        observer.disconnect();
        unsubscribe();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("pagehide", flush);
        if (timer !== null) clearTimeout(timer);
        engine.detach();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [engine]);

  // The native colour input cannot represent "no colour", so a transparent canvas falls
  // back to white there. The ∅ button is the explicit control for transparency.
  const activeColour = slot === "foreground" ? settings.foreground : (settings.background ?? "#ffffff");

  const applyColour = useCallback(
    (colour: string) => {
      const normalised = normalizeHex(colour);
      if (!normalised) return false;
      if (slot === "foreground") engine.setForeground(normalised);
      else engine.setBackground(normalised);

      setRecents((previous) => {
        const next = [normalised, ...previous.filter((c) => c !== normalised)].slice(0, 12);
        try {
          localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
        } catch {
          // Recents are a convenience; a full or blocked store is not worth surfacing.
        }
        return next;
      });
      return true;
    },
    [engine, slot],
  );

  const hexInputRef = useRef<HTMLInputElement>(null);

  const commitHex = useCallback(() => {
    const ok = applyColour(hexDraft);
    setHexError(!ok);
    if (ok) {
      setHexDraft("");
      // Release focus once the colour is applied. Leaving the field focused means the next
      // keystroke is typed into it — so `x` would type a letter instead of swapping colours.
      hexInputRef.current?.blur();
    }
  }, [applyColour, hexDraft]);

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">PaintPad</span>

        <div className="group" role="group" aria-label="Tool">
          {TOOLS.map((tool) => (
            <ToolButton
              key={tool.id}
              tool={tool.id}
              active={settings.tool === tool.id}
              engine={engine}
              label={`${tool.id} (${tool.key})`}
            />
          ))}
        </div>

        <label className="group">
          Size {settings.width}px
          <input
            type="range"
            min={1}
            max={64}
            value={settings.width}
            onChange={(e) => engine.setWidth(Number(e.target.value))}
          />
        </label>

        <button
          type="button"
          aria-pressed={settings.fillShapes}
          data-fill="toggle"
          onClick={() => engine.setFillShapes(!settings.fillShapes)}
          title="Fill shapes with the foreground colour"
          disabled={settings.tool === "pencil" || settings.tool === "eraser"}
        >
          Fill
        </button>

        <button
          type="button"
          data-testid="fill-mode"
          aria-pressed={settings.fillContiguous}
          onClick={() => engine.setFillContiguous(!settings.fillContiguous)}
          title="Bucket: fill the connected region, or every matching pixel"
          disabled={settings.tool !== "fill"}
        >
          {settings.fillContiguous ? "Contiguous" : "Global"}
        </button>

        <div className="group">
          <button
            type="button"
            onClick={() => engine.undo()}
            disabled={!settings.canUndo}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => engine.redo()}
            disabled={!settings.canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
        </div>

        <div className="group">
          <button type="button" onClick={() => engine.setZoom(settings.viewport.zoom / 1.25)}>
            −
          </button>
          <span className="zoom">{Math.round(settings.viewport.zoom * 100)}%</span>
          <button type="button" onClick={() => engine.setZoom(settings.viewport.zoom * 1.25)}>
            +
          </button>
          <button type="button" onClick={() => engine.setZoom(1)}>
            1:1
          </button>
          <button type="button" onClick={() => engine.fitToStage()}>
            Fit
          </button>
          <button
            type="button"
            onClick={() => {
              engine.reset();
              // Clear must wipe the save too, or a reload resurrects what was just cleared.
              void clearDocument();
            }}
          >
            Clear
          </button>
          <button
            type="button"
            data-testid="export"
            onClick={() => void handleExport(engine)}
            title="Download the document as a PNG, at the document's own resolution"
          >
            Export
          </button>
        </div>
      </header>

      <div className="stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="surface"
          aria-label="Drawing canvas"
          style={{ visibility: ready ? "visible" : "hidden" }}
        />
      </div>

      <div className="colourbar">
        <div className="swatches">
          <Swatch
            colour={settings.foreground}
            label="Draw"
            active={slot === "foreground"}
            onSelect={() => setSlot("foreground")}
            testId="swatch-foreground"
          />
          <Swatch
            colour={settings.background}
            label="Canvas"
            active={slot === "background"}
            onSelect={() => setSlot("background")}
            testId="swatch-background"
          />
          <button
            type="button"
            className="swap"
            onClick={() => engine.swapColors()}
            disabled={settings.background === null}
            title={
              settings.background === null
                ? "Set a canvas background to swap"
                : "Swap draw and canvas colours (X)"
            }
          >
            ⇄
          </button>
          <button
            type="button"
            data-testid="background-none"
            className="none"
            aria-pressed={settings.background === null}
            onClick={() => engine.setBackground(null)}
            title="Transparent background"
            disabled={settings.background === null}
          >
            ∅
          </button>
        </div>

        <div className="palette" role="group" aria-label="Palette">
          {DEFAULT_PALETTE.map((colour) => (
            <button
              key={colour}
              type="button"
              className="chip"
              style={{ background: colour }}
              data-colour={colour}
              aria-label={colour}
              title={colour}
              onClick={() => applyColour(colour)}
            />
          ))}
        </div>

        {recents.length > 0 && (
          <div className="palette recents" role="group" aria-label="Recent colours">
            {recents.map((colour) => (
              <button
                key={colour}
                type="button"
                className="chip small"
                style={{ background: colour }}
                data-recent={colour}
                aria-label={`recent ${colour}`}
                onClick={() => applyColour(colour)}
              />
            ))}
          </div>
        )}

        <div className="hex">
          <input
            type="color"
            aria-label="Custom colour"
            data-testid="colour-input"
            value={activeColour}
            onChange={(e) => applyColour(e.target.value)}
          />
          <input
            type="text"
            ref={hexInputRef}
            className={hexError ? "invalid" : ""}
            data-testid="hex-input"
            placeholder="#rrggbb"
            aria-label="Hex colour"
            aria-invalid={hexError}
            value={hexDraft}
            onChange={(e) => {
              setHexDraft(e.target.value);
              setHexError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitHex();
            }}
          />
          <button type="button" onClick={commitHex} disabled={hexDraft.trim() === ""}>
            Set
          </button>
        </div>
      </div>

      <footer className="bar foot">
        <span>Drag to draw · wheel to zoom · space-drag or middle-drag to pan</span>
        <span>
          {settings.tool} · {settings.width}px · {Math.round(settings.viewport.zoom * 100)}% ·{" "}
          {settings.recordCount} op{settings.recordCount === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
  );
}

function Swatch({
  colour,
  label,
  active,
  onSelect,
  testId,
}: {
  colour: string | null;
  label: string;
  active: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={`swatch${colour === null ? " transparent" : ""}`}
      style={colour === null ? undefined : { background: colour, color: readableTextOn(colour) }}
      aria-pressed={active}
      aria-label={label}
      title={`${label} ${colour ?? "transparent"}`}
      data-testid={testId}
      onClick={onSelect}
    >
      <span>{label}</span>
      <code>{colour ?? "none"}</code>
    </button>
  );
}

/**
 * Download the document as a PNG.
 *
 * The engine owns compositing (background beneath artwork, at the document's raster size);
 * the anchor plumbing belongs here. The object URL is revoked immediately after the click —
 * revoking it synchronously can race the download in some browsers, so it is deferred.
 */
async function handleExport(engine: Engine): Promise<void> {
  const blob = await engine.exportBlob();
  if (!blob) return;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = engine.exportFilename();
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ToolButton({
  tool,
  active,
  engine,
  label,
}: {
  tool: ToolId;
  active: boolean;
  engine: Engine;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-tool={tool}
      onClick={() => engine.setTool(tool)}
      title={label}
    >
      {tool}
    </button>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);