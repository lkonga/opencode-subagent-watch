/**
 * MINIMAL COMPATIBILITY DECLARATION — not full API parity.
 *
 * Local type shim for the runtime-provided V2 TUI plugin module. V2 does not
 * publish an installable `@opencode/plugin/tui` package: the binary injects it
 * through the OpenTUI runtime module map
 * (`ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": ... } })`),
 * so external plugins cannot resolve types from node_modules.
 *
 * This declares exactly the subset this plugin calls — nothing more. It is not
 * a copy of the upstream API and must not be used as one. Signatures mirror the
 * authoritative pinned source at base `9b9457c9de` — V2 2.0.11
 * (`/home/lkonga/codes/opencode/.worktrees/port-v2.0.11-codex-prefix`):
 *   packages/plugin/src/tui/plugin.ts:7-14      — `Definition { id, setup }`, `define`
 *   packages/plugin/src/tui/context.ts:31-53    — `Storage.store`
 *   packages/plugin/src/tui/context.ts:63-68    — `Data.on` over `OpenCodeEvent`
 *   packages/plugin/src/tui/context.ts:69-102   — `Data.session` subset
 *   packages/plugin/src/tui/context.ts:191-202  — `SlotMap`
 *   packages/plugin/src/tui/context.ts:224-267  — `SlotClaim`
 *   packages/plugin/src/tui/context.ts:384-410  — `KeymapCommand`
 *   packages/plugin/src/tui/context.ts:412-425  — `KeymapLayer`
 *   packages/plugin/src/tui/context.ts:440-460  — `Keymap.layer`
 *   packages/plugin/src/tui/context.ts:462-504  — `UI` (`dialog.clear`, `router.navigate`, `slot`)
 *   packages/plugin/src/tui/context.ts:506-522  — `Context`
 *   packages/theme/src/tui/types.ts:32-38       — `ResolvedTheme.text` tokens
 *   packages/client/src/promise/index.ts:23-24  — `OpenCodeEvent`, `OpenCodeClient`
 *   packages/client/src/promise/generated/types.ts — client/event/SessionInfo shape
 *   packages/client/src/promise/generated/types.ts:451-457 — `V2EventServerConnected`
 *
 * Every declaration mirrors the upstream shape instead of widening to `any`.
 */
declare module "@opencode/plugin/tui" {
  import type { RGBA } from "@opentui/core";
  import type { JSX } from "@opentui/solid";
  import type { Store } from "solid-js/store";

  export namespace Plugin {
    export type Cleanup = () => Promise<void> | void;

    /** packages/plugin/src/tui/plugin.ts:7-14. */
    export interface Definition {
      readonly id: string;
      readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
    }

    export function define(plugin: Definition): Definition;

    /**
     * packages/client/src/promise/generated/types.ts:1941-1958 (`SessionInfo`).
     * `ModelRef` (types.ts:9) is inlined so the shim stays self-contained.
     */
    export interface SessionInfo {
      readonly id: string;
      readonly parentID?: string;
      readonly title?: string;
      readonly agent?: string;
      readonly model?: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
      readonly cost: number;
      readonly time: { readonly created: number; readonly updated: number };
    }

    /** packages/client/src/promise/generated/types.ts:490-497 (`model-switched`). */
    export interface SessionMessageInfo {
      readonly type: string;
      readonly model?: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
    }

    /** packages/client/src/promise/generated/types.ts:132-143 (`SessionStructuredError`). */
    export interface SessionStructuredError {
      readonly type: string;
      readonly message: string;
      readonly status?: number;
    }

    /**
     * The subset of the V2 event union this plugin subscribes to. Each arm
     * carries an epoch-millisecond `created` and the session it belongs to
     * (packages/client/src/promise/generated/types.ts:661-669, 748-756,
     * 768-776, 1277-1296, 1960-1981; the `V2Event` union spans types.ts:2359-2452
     * and `EventSubscribeOutput = V2Event` at types.ts:5898).
     */
    export interface WatchEventBase<Type extends string, Data> {
      readonly id: string;
      readonly created: number;
      readonly type: Type;
      readonly data: Data;
    }

    /**
     * packages/client/src/promise/generated/types.ts:451-457
     * (`V2EventServerConnected`). This arm has no `created`: only `id`, the
     * optional `metadata`/`location`, `type` and the empty `data: {}` payload are
     * declared. `data` uses the same `Readonly<Record<string, never>>` encoding as
     * `SlotMap.app` above; nothing here is widened to `any`.
     */
    export interface WatchEventServerConnected {
      readonly id: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
      readonly location?: { readonly directory: string };
      readonly type: "server.connected";
      readonly data: Readonly<Record<string, never>>;
    }

    export type WatchEvent =
      | WatchEventBase<
          "session.created",
          {
            readonly sessionID: string;
            readonly parentID?: string;
            readonly slug: string;
            readonly title?: string;
            readonly agent?: string;
          }
        >
      | WatchEventBase<
          "session.tool.input.started",
          {
            readonly sessionID: string;
            readonly assistantMessageID: string;
            readonly id: string;
            readonly name: string;
          }
        >
      | WatchEventBase<
          "session.reasoning.started",
          {
            readonly sessionID: string;
            readonly assistantMessageID: string;
            readonly ordinal: number;
          }
        >
      | WatchEventBase<
          "session.text.started",
          {
            readonly sessionID: string;
            readonly assistantMessageID: string;
            readonly ordinal: number;
          }
        >
      | WatchEventBase<"session.execution.succeeded", { readonly sessionID: string }>
      | WatchEventBase<
          "session.execution.interrupted",
          {
            readonly sessionID: string;
            readonly reason: "user" | "shutdown" | "superseded" | "inactivity";
          }
        >
      | WatchEventBase<
          "session.execution.failed",
          { readonly sessionID: string; readonly error: SessionStructuredError }
        >
      | WatchEventBase<
          "session.step.failed",
          {
            readonly sessionID: string;
            readonly assistantMessageID: string;
            readonly error: SessionStructuredError;
          }
        >
      | WatchEventBase<
          "session.retry.scheduled",
          {
            readonly sessionID: string;
            readonly assistantMessageID: string;
            readonly attempt: number;
            readonly at: number;
            readonly error: SessionStructuredError;
          }
        >
      | WatchEventServerConnected;

    export type WatchEventType = WatchEvent["type"];

    /** packages/plugin/src/tui/context.ts:382-408 (subset of the command shape). */
    export interface KeymapCommand {
      readonly id?: string;
      readonly title?: string;
      readonly description?: string;
      readonly group?: string;
      readonly bind?: false | string;
      readonly palette?: true;
      readonly slash?: { readonly name: string };
      readonly run: () => void | false | Promise<void>;
    }

    /** packages/plugin/src/tui/context.ts:412-425. */
    export interface KeymapLayer {
      readonly mode?: string;
      readonly commands?: readonly KeymapCommand[];
    }

    /** packages/plugin/src/tui/context.ts:440-460 (`layer` only). */
    export interface Keymap {
      layer(input: () => KeymapLayer): void;
    }

    /**
     * packages/plugin/src/tui/context.ts:191-202. Only the two paths this
     * plugin targets are declared; the upstream map has more.
     */
    export interface SlotMap {
      readonly app: Readonly<Record<string, never>>;
      readonly "sidebar.content": { readonly sessionID: string };
    }

    export type SlotPath = keyof SlotMap;

    /**
     * packages/plugin/src/tui/context.ts:224-267 (`SlotClaim`). Distributive
     * mapped type so each claim keeps the input type of its own target path,
     * with the placement keys mutually exclusive.
     */
    export type SlotClaim = {
      [Path in SlotPath]: { readonly render: (input: SlotMap[Path]) => JSX.Element } & (
        | {
            readonly prepend: Path;
            readonly append?: never;
            readonly before?: never;
            readonly after?: never;
            readonly replace?: never;
          }
        | {
            readonly append: Path;
            readonly prepend?: never;
            readonly before?: never;
            readonly after?: never;
            readonly replace?: never;
          }
        | {
            readonly before: Path;
            readonly prepend?: never;
            readonly append?: never;
            readonly after?: never;
            readonly replace?: never;
          }
        | {
            readonly after: Path;
            readonly prepend?: never;
            readonly append?: never;
            readonly before?: never;
            readonly replace?: never;
          }
        | {
            readonly replace: Path;
            readonly prepend?: never;
            readonly append?: never;
            readonly before?: never;
            readonly after?: never;
          }
      );
    }[SlotPath];

    /** packages/theme/src/tui/types.ts:32-38 (`ResolvedTheme.text` subset). */
    export type FeedbackKind = "info" | "success" | "warning" | "error";

    export interface Theme {
      readonly text: {
        readonly base: RGBA;
        readonly muted: RGBA;
        readonly feedback: Readonly<
          Record<FeedbackKind, { readonly base: RGBA; readonly muted: RGBA }>
        >;
      };
    }

    /**
     * packages/plugin/src/tui/context.ts:31-53. The authoritative declaration
     * has a required `key: string` and `options` carrying only `initial`, so no
     * optionality is added here.
     */
    export interface Storage {
      store<Value extends object>(
        key: string,
        options: { readonly initial: Value },
      ): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>];
    }

    /**
     * packages/plugin/src/tui/context.ts:69-102 (`Data.session` subset) and
     * 63-68 (`Data.on`).
     */
    export interface Data {
      on<Type extends WatchEventType>(
        type: Type,
        handler: (event: Extract<WatchEvent, { type: Type }>) => void,
      ): () => void;
      readonly session: {
        get(sessionID: string): SessionInfo | undefined;
        family(sessionID: string): readonly string[];
        status(sessionID: string): "idle" | "running";
        sync(sessionID: string): Promise<void>;
        readonly message: { list(sessionID: string): readonly SessionMessageInfo[] };
      };
    }

    /**
     * packages/plugin/src/tui/context.ts:462-504 (`UI`, used members only):
     * `dialog.clear` (371-382, `clear` at 377), `router.navigate` (`:468-471`),
     * `slot` (:503).
     */
    export interface UI {
      readonly dialog: { clear(): void };
      readonly router: {
        navigate(destination: { readonly type: "session"; readonly sessionID: string }): void;
      };
      readonly slot: (claim: SlotClaim) => () => void;
    }

    /**
     * packages/plugin/src/tui/context.ts:506-522, narrowed to the members this
     * plugin reads. `client` is the generated `OpenCodeClient`
     * (packages/client/src/promise/index.ts:24); only `session.list` is
     * declared, with the authoritative input `SessionListInput`
     * (types.ts:2728-2809) and return shape
     * `SessionListOutput = SessionsResponse` (types.ts:2206-2218, 2811).
     */
    export interface Context {
      readonly theme: Theme;
      readonly client: {
        readonly session: {
          list(input: {
            readonly parentID?: string | null;
            readonly order?: "asc" | "desc";
            readonly limit?: number;
          }): Promise<{
            readonly data: readonly SessionInfo[];
            readonly cursor: {
              readonly previous?: string | null;
              readonly next?: string | null;
            };
          }>;
        };
      };
      readonly data: Data;
      readonly storage: Storage;
      readonly keymap: Keymap;
      readonly ui: UI;
    }
  }
}
