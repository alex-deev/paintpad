/**
 * Analytics.
 *
 * A sink, and nothing else. No provider is imported and no network call is made from here —
 * the app never talks to a vendor directly, it hands an event to whatever sink is installed.
 * That keeps the unconfigured case (the shipping default today) a genuine no-op, and it means
 * adding a provider later is a startup call rather than an edit to the export flow.
 *
 * The event payloads carry no identifiers, no document contents and no colour values. If a
 * future event cannot be described without one of those, it does not belong in this file.
 */

import type { ExportTierId } from "./canvas/exportScale";

export type AnalyticsEvent =
  | { readonly name: "export_modal_opened" }
  | {
      readonly name: "export_tier_selected";
      readonly tier: ExportTierId;
      readonly width: number;
      readonly height: number;
    }
  | { readonly name: "export_completed"; readonly tier: ExportTierId }
  | { readonly name: "export_cancelled" };

export type AnalyticsSink = (event: AnalyticsEvent) => void;

let sink: AnalyticsSink | null = null;

/**
 * Install a provider, or pass `null` to remove it.
 *
 * Set once at startup. Events emitted before this are dropped, not buffered: replaying a
 * backlog on a slow connection would be a worse trade than losing a few of them.
 */
export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

/**
 * Report an event, if anywhere is listening.
 *
 * Deliberately swallows provider failures. Every call site sits inside the export flow, and
 * a blocked or erroring request from a third party must not be able to fail a download.
 */
export function track(event: AnalyticsEvent): void {
  try {
    sink?.(event);
  } catch {
    // Reporting is never worth breaking the editor for.
  }
}
