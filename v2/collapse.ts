/**
 * Durable collapse state for the V2 panel.
 *
 * The V2 host store is JSON-backed and shared with other TUI instances, so the
 * persisted value can be missing or malformed (hand-edited file, an older
 * schema, a partial write). Only `typeof collapsed === "boolean"` is accepted:
 * anything else renders collapsed and is left untouched — startup never writes
 * a default over whatever is on disk.
 *
 * Host mutations are asynchronous and may resolve out of order, so toggles are
 * optimistic (a local signal keeps the panel responsive) and serialized through
 * a promise queue (each write is issued only after the previous one settles).
 * A rejected write is swallowed; it must not surface as an unhandled rejection
 * or roll the panel back.
 */
import { createSignal } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";

/** Deterministic V2 storage key, distinct from the V1 `opencode-subagent-watch.collapsed`. */
export const COLLAPSED_KEY = "sidebar-collapsed.v1";
export const DEFAULT_COLLAPSED = true;
export type WatchState = { collapsed: boolean };
export const COLLAPSED_INITIAL: Readonly<WatchState> = { collapsed: DEFAULT_COLLAPSED };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict read of a persisted draft: only an explicit boolean is accepted. */
export function readCollapsed(state: unknown): boolean | undefined {
  if (!isRecord(state)) return undefined;
  const value = state["collapsed"];
  return typeof value === "boolean" ? value : undefined;
}

export type CollapsedToggle = {
  readonly collapsed: () => boolean;
  readonly toggle: () => void;
};

export function createCollapsedToggle(context: Plugin.Context): CollapsedToggle {
  const [state, mutate] = context.storage.store<WatchState>(COLLAPSED_KEY, {
    initial: COLLAPSED_INITIAL,
  });
  const [pending, setPending] = createSignal<boolean>();
  const collapsed = (): boolean => pending() ?? readCollapsed(state) ?? DEFAULT_COLLAPSED;
  let queue: Promise<void> = Promise.resolve();

  const toggle = (): void => {
    const next = !collapsed();
    setPending(next);
    queue = queue.then(async () => {
      try {
        await mutate((draft) => {
          draft.collapsed = next;
        });
      } catch {
        // Keep the optimistic value: a failed write must not reject the queue.
        return;
      }
      // A newer toggle owns the pending signal now; leave it alone.
      if (pending() === next) setPending(undefined);
    });
  };

  return { collapsed, toggle };
}
