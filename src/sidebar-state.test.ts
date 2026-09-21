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

  test("orders Subagents after Token Cache and before core Todo in the sidebar", () => {
    // V1 slot orders: Token Cache 55, core Context 100, MCP 200, LSP 300,
    // core Todo 400. 60 therefore yields Token Cache → Subagents → Todo,
    // with Context/MCP/LSP in between.
    expect(SIDEBAR_ORDER).toBe(60);
    expect(SIDEBAR_ORDER).toBeGreaterThan(55);
    expect(SIDEBAR_ORDER).toBeLessThan(400);
  });
});
