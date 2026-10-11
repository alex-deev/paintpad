import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Engine } from "./canvas/engine";
import type { ToolId } from "./canvas/record";
import "./styles.css";

const TOOLS: { id: ToolId; key: string }[] = [
  { id: "pencil", key: "1" },
  { id: "eraser", key: "2" },
  { id: "line", key: "3" },
  { id: "rect", key: "4" },
  { id: "ellipse", key: "5" },
];

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

  const settings = useSyncExternalStore(
    (onChange) => engine.subscribe(() => onChange()),
    () => engine.settings(),
    () => engine.settings(),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    engine.attach(canvas, stage);

    const observer = new ResizeObserver(() => {
      engine.setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    });
    observer.observe(stage);

    // Expose for Playwright goldens and manual poking.
    (window as unknown as { __paintpad: Engine }).__paintpad = engine;

    return () => {
      observer.disconnect();
      engine.detach();
    };
  }, [engine]);

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">PaintPad</span>
        <span className="hint">render-engine harness</span>

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
          <button type="button" onClick={() => engine.reset()}>
            Clear
          </button>
        </div>
      </header>

      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} className="surface" aria-label="Drawing canvas" />
      </div>

      <footer className="bar foot">
        <span>Drag to draw · wheel to zoom · space-drag or middle-drag to pan</span>
        <span>
          {settings.tool} · {settings.width}px · {Math.round(settings.viewport.zoom * 100)}% ·{" "}
          {settings.recordCount} stroke{settings.recordCount === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
  );
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