import { afterEach, describe, expect, it } from "vitest";
import { setAnalyticsSink, track, type AnalyticsEvent } from "../../src/analytics";

/** The sink is module state, so every test has to hand it back clean. */
afterEach(() => setAnalyticsSink(null));

describe("track", () => {
  it("drops events silently when no provider is configured", () => {
    // Shipping without a provider is the default: it must be a no-op, not a crash.
    expect(() => track({ name: "export_modal_opened" })).not.toThrow();
  });

  it("routes an event to the configured provider", () => {
    const seen: AnalyticsEvent[] = [];
    setAnalyticsSink((event) => seen.push(event));

    track({ name: "export_modal_opened" });

    expect(seen).toEqual([{ name: "export_modal_opened" }]);
  });

  it("reports the tier and the dimensions actually chosen", () => {
    const seen: AnalyticsEvent[] = [];
    setAnalyticsSink((event) => seen.push(event));

    track({ name: "export_tier_selected", tier: "small", width: 640, height: 360 });
    track({ name: "export_completed", tier: "small" });

    expect(seen).toEqual([
      { name: "export_tier_selected", tier: "small", width: 640, height: 360 },
      { name: "export_completed", tier: "small" },
    ]);
  });

  it("stops routing once the provider is removed", () => {
    const seen: AnalyticsEvent[] = [];
    setAnalyticsSink((event) => seen.push(event));
    setAnalyticsSink(null);

    track({ name: "export_cancelled" });

    expect(seen).toEqual([]);
  });

  it("never lets a failing provider break the editor", () => {
    // The call site is inside the export flow. A provider that throws on a blocked request
    // must not be able to take the user's download down with it.
    setAnalyticsSink(() => {
      throw new Error("request blocked");
    });

    expect(() => track({ name: "export_completed", tier: "full" })).not.toThrow();
  });

  it("carries nothing beyond the declared fields", () => {
    const seen: AnalyticsEvent[] = [];
    setAnalyticsSink((event) => seen.push(event));

    track({ name: "export_tier_selected", tier: "standard", width: 1280, height: 720 });

    // No identifiers, no document contents, no colour values — nothing that would make an
    // event personal data.
    expect(Object.keys(seen[0]!).sort()).toEqual(["height", "name", "tier", "width"]);
    expect(Object.values(seen[0]!)).toContain("standard");
  });
});
