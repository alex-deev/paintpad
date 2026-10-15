import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: {
    globals: true,
    // Pure modules only. Vitest's jsdom does not implement Canvas 2D, so anything
    // touching a canvas is covered by Playwright instead — see the testing strategy in
    // SPEC-render-engine.md.
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Only the DOM-free modules are measurable here. `engine.ts`, `record.ts` and
      // `main.tsx` need a real canvas, so they are gated by the Playwright goldens
      // instead of a node coverage number.
      include: [
        "src/analytics.ts",
        "src/canvas/color.ts",
        "src/canvas/document.ts",
        "src/canvas/exportScale.ts",
        "src/canvas/floodfill.ts",
        "src/canvas/history.ts",
        "src/canvas/selection.ts",
        "src/canvas/serialize.ts",
        "src/canvas/shape.ts",
        "src/canvas/stroke.ts",
        "src/canvas/viewport.ts",
      ],
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});