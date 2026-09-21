# opencode-subagent-watch — V2 port

The V2 TUI entrypoint for `opencode-subagent-watch`. It keeps the V1 panel
(status symbols, header counts, activity/duration/cost rows, click-to-navigate,
collapse toggle) and reads the V2 host's reactive session store instead of
maintaining its own event-driven tracker.

The V1 entrypoint is unchanged: `src/tui.tsx` still builds to `dist/tui.js` and
still loads under the V1 runtime. The V1 sidebar order is now 60 (was 50), so
the panel renders after Token Cache (order 55) and still before core Todo
(order 400): Token Cache → Subagents → Todo. V1 also renders Context (100), MCP
(200) and LSP (300) between them.

V2 placement is stricter and has no numeric order. `sidebar.content` is a single
slot, so position is decided by **plugin enable order** — the `cli.json`
`plugins` array. Registering this plugin last makes its
`append: "sidebar.content"` claim the final append contribution, i.e. after
Token Cache. V2 2.0.11 has **no core Todo sidebar section at all** (only
`feature-plugins/sidebar/{context,mcp,footer}.tsx`), so "before Todo" is
vacuous in V2; the only guarantee there is "after Token Cache, last append".

## Canonical lineage

The canonical implementation of this V2 port lives in the
`wt/custom/feat/v2-sidebar-parity` worktree
(`.worktrees/sidebar-parity`, branch `wt/custom/feat/v2-sidebar-parity`). It
supersedes the earlier issue-230 prototype on
`wt/v2/feat/issue-230-subagent-watch` (commits `bc3424d`, `7e977a6`, `6c66681`);
those prototype commits are historical only and this worktree is the lineage to
build, test, and ship from. This note does not claim that the prototype branch
has been deleted or merged.

## Files

| File                       | Purpose                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `tui.tsx`                  | V2 plugin entry (`Plugin.define`) — sidebar view + `/subagents` action                 |
| `subagents.ts`             | Pure display model ported from `src/{subagent,sidebar,activity}.ts`                    |
| `watch.ts`                 | Per-view controller: filtered events, reconnect coalescing, bounded hydration, pruning |
| `collapse.ts`              | Strict persisted collapse state with a serialized toggle queue                         |
| `subagents.test.ts`        | Focused tests for the display model                                                    |
| `watch.test.ts`            | Controller tests: filtering, reconnect refresh, limits, concurrency, cancellation      |
| `tui.test.ts`              | Setup/render/nav/tracking/storage tests through a typed fake context                   |
| `testing/harness.ts`       | Typed `Plugin.Context` fakes backed by Solid stores                                    |
| `package.test.ts`          | V2 package contract + untouched V1 export/state regression tests                       |
| `opencode-plugin-tui.d.ts` | Minimal compatibility declaration for the runtime-provided module                      |
| `scripts/build.ts`         | Regenerates `dist/tui.js` from `tui.tsx`                                               |
| `dist/tui.js`              | Generated artifact (committed; never hand-edited)                                      |

## Registering it

V2 has no `tui.json`; TUI plugins are listed in `cli.json`
(`packages/tui/src/config/index.tsx:47-55` schema, `:76` field):

```json
{
  "plugins": ["/home/lkonga/codes/opencode-plugins/opencode-subagent-watch/v2/dist/tui.js"]
}
```

Register the **built artifact path** (`v2/dist/tui.js`), not the package
directory: V2 resolves a directory target through `Host.resolve` →
`entry(["tui"])` (`packages/plugin/src/host.ts:17-43`), which joins `<dir>/tui`
and would load `v2/tui.tsx` instead of the package's `exports` map. Naming the
built file makes the loaded runtime bytes explicit. The package's `.` and
`./tui` exports both resolve to that same `./dist/tui.js`.

## Public API used

Pinned source `/home/lkonga/codes/opencode/.worktrees/port-v2.0.11-codex-prefix`,
base `9b9457c9de` (**V2 2.0.11** — revalidated against this ref; the earlier
draft cited `11d3e72fdd`, which is V2 2.0.3 and had different theme token names).

- module shape — `packages/plugin/src/tui/plugin.ts:7-14` (`Definition { id, setup }`, `define`)
- context surface — `packages/plugin/src/tui/context.ts:506-522`
- sidebar slot — `packages/plugin/src/tui/context.ts:191-202, 224-267, 503`
- session data — `packages/plugin/src/tui/context.ts:69-102`
- events — `packages/plugin/src/tui/context.ts:63-68`
- `server.connected` reconnect event — `packages/client/src/promise/generated/types.ts:451-457`
- keymap — `packages/plugin/src/tui/context.ts:412-425, 440-460`
- storage — `packages/plugin/src/tui/context.ts:31-53`
- router — `packages/plugin/src/tui/context.ts:468-471`
- theme text tokens — `packages/theme/src/tui/types.ts:32-38` (`text.base`, `text.muted`, `text.feedback[kind].base`)
- config `plugins` — `packages/tui/src/config/index.tsx:47-55, 76`
- plugin entry resolution — `packages/plugin/src/host.ts:17-43`
- runtime module map — `packages/tui/src/plugin/runtime-plugin-support.bun.ts:4-8`

No upstream V2 core patches are required. The runtime-provided module name is
`@opencode/plugin/tui`; the binary maps it in `ensureRuntimePluginSupport`, and
`opencode-plugin-tui.d.ts` keeps this package typechecked against that contract
(`RGBA` colors, the watched event union, per-path slot inputs) without `any`.
That file is a minimal compatibility declaration of the subset this plugin
calls — it is not a complete mirror of the upstream API.

## State

- Plugin id: `opencode-subagent-watch-v2-tui`
- Storage key: `sidebar-collapsed.v1`, initial `{ collapsed: true }` — separate
  from the V1 `opencode-subagent-watch.collapsed`, so the runtimes never fight
  over one value.
- Only `typeof state.collapsed === "boolean"` is accepted. A missing or
  malformed persisted value renders collapsed and is left untouched; startup
  never writes a default over it.
- Toggling the header (or the `/subagents` command) persists through
  `context.storage.store`. Toggles are optimistic and serialized, so rapid
  clicks stay deterministic even when host writes resolve out of order; a
  rejected write is swallowed instead of becoming an unhandled rejection.

## Differences from V1

- V2 exposes `data.session.status()` as `"idle" | "running"` only
  (`packages/plugin/src/tui/context.ts:75`). `retry` and `error` are derived
  from `session.retry.scheduled`, `session.execution.failed`, and
  `session.step.failed`, and are cleared once the session runs again.
- V2 user messages carry no model
  (`packages/client/src/promise/generated/types.ts:490-497` carries the
  `model-switched` message), so the parent-model fallback reads the newest
  `model-switched` message.
- The theme tokens are `text.base` / `text.muted` /
  `text.feedback[kind].base` as of V2 2.0.11. The earlier 2.0.3 names
  (`text.default` / `text.subdued` / `feedback[kind].default`) resolve to
  `undefined` on 2.0.11 and render uncoloured text, so this port must not
  regress to them.
- The panel action uses `bind: false` and exposes the palette + `/subagents`
  slash command. V2 rejects unknown keybind ids at parse time
  (`packages/tui/src/config/keybind.ts:314-317`), so no keybind is invented.
- The host owns session data, so children the host has not synced yet are
  pulled in through `client.session.list` + `data.session.sync`. Each refresh
  requests a finite page (`HYDRATION_LIMIT = 50`) and hydrates every missing
  direct child that page returns, with `HYDRATION_CONCURRENCY = 4` syncs in
  flight, and drops results from a disposed view or a previous parent.
- A `server.connected` reconnect refreshes the panel for whichever parent is
  rendered then. A burst of synchronous reconnect signals coalesces into one
  refresh (microtask latch), and a queued refresh never fires once the view is
  disposed. Collapse state stays storage-owned and is untouched by reconnects.
- Event-driven activity, error and retry marks only apply to direct children of
  the currently rendered parent; `session.created` only triggers a refresh when
  `event.data.parentID` matches that parent.

## Building and testing

```bash
bun v2/scripts/build.ts    # regenerate v2/dist/tui.js from v2/tui.tsx
bun test v2                # display model + plugin + package contract tests
bun run smoke:v2           # artifact freshness, exports, and load smoke
```

The bundle is **byte-sensitive to the Bun version** (Bun renames de-duplicated
locals and reorders exports differently across releases). CI pins `1.3.14`
(`.github/workflows/ci.yaml`), and `smoke:v2` asserts the tracked
`v2/dist/tui.js` is byte-identical to a fresh rebuild, so regenerate the
committed artifact with that same Bun version — otherwise the freshness
assertion fails on a different Bun even though the source is unchanged.
