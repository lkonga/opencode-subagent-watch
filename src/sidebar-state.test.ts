import { describe, expect, test } from "bun:test";
import { COLLAPSED_KEY, DEFAULT_COLLAPSED, SIDEBAR_ORDER, restoreCollapsed } from "./sidebar-state";

describe("sidebar registration state", () => {
  test("is collapsed for a fresh or reloaded process without saved state", () => {
    const kv = { get: <T>(_key: string, fallback: T) => fallback };

    expect(DEFAULT_COLLAPSED).toBe(true);
    expect(restoreCollapsed(kv)).toBe(true);
    expect(restoreCollapsed(kv)).toBe(true);
  });

  test("restores an explicit user expansion", () => {
    const kv = {
      get: <T>(key: string, fallback: T) => (key === COLLAPSED_KEY ? false : fallback) as T,
    };

    expect(restoreCollapsed(kv)).toBe(false);
  });

  test("orders Subagents before Token Cache's supported slot order", () => {
    expect(SIDEBAR_ORDER).toBeLessThan(55);
  });
});
