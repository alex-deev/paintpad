/**
 * Tool icons — inline SVG, stroke-based, sized by CSS.
 *
 * These exist for space and scannability, not decoration. Seven text labels were wide enough
 * that the toolbar overflowed the viewport and pushed the stage off screen; icons cut the tool
 * row to roughly a third of that. `currentColor` means the active-tool styling in `styles.css`
 * applies with no extra rules here.
 *
 * Each icon is drawn on a 24x24 grid with a 2px stroke, which keeps them optically consistent
 * without needing a viewBox adjustment per shape.
 */

import type { JSX } from "react";
import type { ToolId } from "../canvas/record";

const PATHS: Record<ToolId, JSX.Element> = {
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  eraser: (
    <>
      <path d="m7 21-4.3-4.3a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </>
  ),
  line: (
    <>
      <path d="M6 18 18 6" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
    </>
  ),
  rect: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  ellipse: <ellipse cx="12" cy="12" rx="8" ry="6" />,
  fill: (
    <>
      <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0L19 11Z" />
      <path d="m5 2 5 5" />
      <path d="M2 13h15" />
      <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z" />
    </>
  ),
  select: <rect x="4" y="5" width="16" height="14" rx="1.5" strokeDasharray="3 2.5" />,
};

/** Icon for a tool. Hidden from assistive tech — the button already carries the name. */
export function ToolIcon({ tool }: { tool: ToolId }): JSX.Element {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[tool]}
    </svg>
  );
}