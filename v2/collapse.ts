/**
 * Durable collapse state for the V2 panel.
 *
 * The V2 host store is JSON-backed and shared with other TUI instances, so the
 * persisted value can be missing or malformed (hand-edited file, an older
 * schema, a partial write). Only `typeof collapsed === "boolean"` is accepted:
 * anything else renders collapsed and is left untouched — startup never writes
 * a default over whatever is on disk.
 *
 * V1 parity: the state is still the plugin's semantic `collapsed` key, with the
 * same default (`true`) and the same restore rule (an absent or malformed value
 * renders collapsed and is never overwritten at startup). The host namespaces
 * this key as `plugin.<pluginId>.collapsed`, and V2 durable storage is
 * object-valued (`Store<Value extends object>`), so V1's flat
 * `opencode-subagent-watch.collapsed` boolean cannot be shared literally — the
 * name and semantics are matched, not the on-disk byte shape.
 *
 * Host mutations are asynchronous and may resolve out of order, so toggles are
 * optimistic (a local signal keeps the panel responsive) and serialized through
 * a promise queue (each write is issued only after the previous one settles).
 * A rejected write is swallowed; it must not surface as an unhandled rejection
 * or roll the panel back.
 */
import { createSignal } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";

/**
 * The plugin's semantic collapse key. V1 writes `open...collapsed` into the flat
 * TUI KV; the V2 host prefixes every plugin key with `plugin.<pluginId>.`, so
 * the same semantic key here becomes `plugin.opencode-subagent-watch-v2-tui.collapsed`.
 */
export const COLLAPSED_KEY = "collapsed";
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
