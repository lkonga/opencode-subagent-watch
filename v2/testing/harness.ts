/**
 * Typed fakes for the V2 TUI plugin context.
 *
 * The plugin talks to the host through `Plugin.Context` (`context.data`,
 * `context.client`, `context.ui`, `context.storage`, `context.keymap`). These
 * fakes implement exactly that interface with Solid primitives, so tests get
 * real reactivity without a live V2 host and without casting away types.
 *
 * The fakes also model the host's asynchronous edges, which is what the
 * controller tests need:
 *   - `client.session.list` can be held open (`deferLists`) so a stale response
 *     can be released after a parent change;
 *   - `data.session.sync` can be held open and reports in-flight/max-in-flight
 *     counts (`deferSync`, `releaseSync`, `syncInFlight`, `syncMaxInFlight`);
 *   - `storage.store` mutations can be held open (`deferMutations`), released
 *     out of order, made to fail (`failMutations`), and record what was
 *     actually committed (`storageWrites`).
 */
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { Plugin } from "@opencode/plugin/tui";

export type SessionStatus = "idle" | "running";

export type SessionInit = {
  readonly id: string;
  readonly parentID?: string;
  readonly title?: string;
  readonly agent?: string;
  readonly model?: Plugin.SessionInfo["model"];
  readonly cost?: number;
  readonly created?: number;
  readonly updated?: number;
};

export type ListInput = {
  readonly parentID?: string | null;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
};

export type Harness = {
  readonly context: Plugin.Context;
  /** Every slot claim the plugin registered, in order. */
  readonly claims: readonly Plugin.SlotClaim[];
  /** Keymap layers the plugin registered. */
  readonly keymapLayers: readonly Plugin.KeymapLayer[];
  /** Storage keys/initials the plugin asked for. */
  readonly storageKeys: readonly string[];
  readonly storageInitials: readonly unknown[];
  /** Values committed by `storage.store` mutations, in commit order. */
  readonly storageWrites: readonly unknown[];
  readonly routerCalls: readonly { readonly type: "session"; readonly sessionID: string }[];
  readonly dialogClears: readonly string[];
  readonly syncCalls: readonly string[];
  readonly listInputs: readonly ListInput[];
  /** The plugin's durable collapsed flag, or undefined before it is written. */
  collapsed(): boolean | undefined;
  /** Renders the `sidebar.content` claim for `sessionID`. */
  sidebar(sessionID: string): JSX.Element;
  /** Renders the `app` claim (commands). */
  app(): JSX.Element;
  /** Adds a session to the host store, as if the host had already synced it. */
  addSession(init: SessionInit, status?: SessionStatus): void;
  /**
   * Publishes a session the host knows about but has not synced yet — the
   * `client.session.list` + `data.session.sync` adapter path.
   */
  unsynced(init: SessionInit): void;
  /**
   * Publishes a family entry with no store record, the way a stale host index
   * can reference a session the adapter has not loaded.
   */
  orphan(parentID: string, sessionID: string): void;
  setStatus(id: string, status: SessionStatus): void;
  setMessages(id: string, messages: readonly Plugin.SessionMessageInfo[]): void;
  /** Makes the next `client.session.list` call reject (host unavailable). */
  setListError(message: string | undefined): void;
  emit(event: Plugin.WatchEvent): void;
  /** Number of live `data.on` subscriptions (cleanup regression). */
  subscriptionCount(): number;
  /** Holds `client.session.list` promises open until `releaseLists`. */
  deferLists(enabled: boolean): void;
  /** Number of list calls still held open. */
  pendingListCount(): number;
  /** Resolves the oldest `count` held-open list calls, awaiting a macrotask. */
  releaseLists(count?: number): Promise<void>;
  /** Holds `data.session.sync` promises open until `releaseSync`. */
  deferSync(enabled: boolean): void;
  /** In-flight syncs (bounded-concurrency regression). */
  syncInFlight(): number;
  /** High-water mark of in-flight syncs. */
  syncMaxInFlight(): number;
  /** Releases held-open syncs, including ones started by the release itself. */
  releaseSync(): Promise<void>;
  /** Holds `storage.store` mutations open until `flushMutations`. */
  deferMutations(enabled: boolean): void;
  /** Number of storage mutations still held open. */
  pendingMutationCount(): number;
  /** Makes the next storage mutation reject. */
  failMutations(message: string | undefined): void;
  /** Releases held-open storage mutations oldest-first until none remain. */
  flushMutations(): Promise<void>;
};

export type HarnessOptions = {
  /**
   * Pre-existing durable value, as if written by a previous session. `unknown`
   * on purpose: malformed persisted state is part of the contract.
   */
  readonly persisted?: unknown;
};

export function rgba(red: number, green: number, blue: number): RGBA {
  return RGBA.fromValues(red / 255, green / 255, blue / 255, 1);
}

export function theme(): Plugin.Theme {
  return {
    text: {
      base: rgba(255, 255, 255),
      muted: rgba(128, 128, 128),
      feedback: {
        error: { base: rgba(255, 0, 0), muted: rgba(255, 0, 0) },
        warning: { base: rgba(255, 170, 0), muted: rgba(255, 170, 0) },
        success: { base: rgba(0, 255, 0), muted: rgba(0, 255, 0) },
        info: { base: rgba(0, 255, 255), muted: rgba(0, 255, 255) },
      },
    },
  };
}

/** Yields to the macrotask queue so chained host promises settle. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isWatchEvent<Type extends Plugin.WatchEventType>(
  event: Plugin.WatchEvent,
  type: Type,
): event is Extract<Plugin.WatchEvent, { type: Type }> {
  return event.type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const [sessions, setSessions] = createStore<{
    byID: Record<string, Plugin.SessionInfo>;
    children: Record<string, string[]>;
    statuses: Record<string, SessionStatus>;
    messages: Record<string, Plugin.SessionMessageInfo[]>;
  }>({ byID: {}, children: {}, statuses: {}, messages: {} });

  const listeners = new Map<Plugin.WatchEventType, Set<(event: Plugin.WatchEvent) => void>>();
  let subscriptions = 0;

  const info = (init: SessionInit): Plugin.SessionInfo => ({
    id: init.id,
    parentID: init.parentID,
    title: init.title ?? init.id,
    agent: init.agent,
    model: init.model,
    cost: init.cost ?? 0,
    time: { created: init.created ?? 1_000, updated: init.updated ?? 1_000 },
  });

  const known = new Map<string, SessionInit>();
  const listInputs: ListInput[] = [];
  const syncCalls: string[] = [];
  let listError: string | undefined;

  function store(init: SessionInit, status: SessionStatus = "idle"): void {
    setSessions("byID", init.id, info(init));
    if (init.parentID)
      setSessions("children", init.parentID, (current) =>
        current?.includes(init.id) ? current : [...(current ?? []), init.id],
      );
    if (status !== "idle") setSessions("statuses", init.id, status);
  }

  /**
   * Publishes a family entry without a store record, the way a stale host index
   * can reference a session the adapter has not loaded.
   */
  function orphan(parentID: string, sessionID: string): void {
    setSessions("children", parentID, (current) =>
      current?.includes(sessionID) ? current : [...(current ?? []), sessionID],
    );
  }

  const data: Plugin.Context["data"] = {
    on<Type extends Plugin.WatchEventType>(
      type: Type,
      handler: (event: Extract<Plugin.WatchEvent, { type: Type }>) => void,
    ): () => void {
      const set = listeners.get(type) ?? new Set<(event: Plugin.WatchEvent) => void>();
      const wrapped = (event: Plugin.WatchEvent) => {
        if (isWatchEvent(event, type)) handler(event);
      };
      set.add(wrapped);
      listeners.set(type, set);
      subscriptions += 1;
      return () => {
        if (set.delete(wrapped)) subscriptions -= 1;
      };
    },
    session: {
      get: (sessionID) => sessions.byID[sessionID],
      family: (sessionID) => sessions.children[sessionID] ?? [],
      status: (sessionID) => sessions.statuses[sessionID] ?? "idle",
      sync: async (sessionID) => {
        syncCalls.push(sessionID);
        syncInFlight += 1;
        syncMaxInFlight = Math.max(syncMaxInFlight, syncInFlight);
        try {
          if (syncDeferred) await new Promise<void>((resolve) => pendingSync.push(resolve));
          const pending = known.get(sessionID);
          if (pending) store(pending);
        } finally {
          syncInFlight -= 1;
        }
      },
      message: { list: (sessionID) => sessions.messages[sessionID] ?? [] },
    },
  };

  let listsDeferred = false;
  const pendingLists: Array<{ readonly resolve: () => void }> = [];
  let syncDeferred = false;
  let syncInFlight = 0;
  let syncMaxInFlight = 0;
  const pendingSync: Array<() => void> = [];

  const client: Plugin.Context["client"] = {
    session: {
      list: async (input) => {
        listInputs.push(input);
        const parentID = input.parentID ?? undefined;
        const matches = [...known.values()].filter((init) => init.parentID === parentID);
        // The real host honors the request limit, so the fake does too: the
        // page-size bound is behavioral, not merely a request shape.
        const data = matches.slice(0, input.limit ?? matches.length).map(info);
        const result = (): {
          readonly data: readonly Plugin.SessionInfo[];
          readonly cursor: { readonly previous?: string | null; readonly next?: string | null };
        } => {
          if (listError) throw new Error(listError);
          return { data, cursor: {} };
        };
        if (!listsDeferred) return result();
        await new Promise<void>((resolve) => pendingLists.push({ resolve }));
        return result();
      },
    },
  };

  const routerCalls: { readonly type: "session"; readonly sessionID: string }[] = [];
  const dialogClears: string[] = [];
  const claims: Plugin.SlotClaim[] = [];
  let sidebarRender: ((input: { readonly sessionID: string }) => JSX.Element) | undefined;
  let appRender: (() => JSX.Element) | undefined;

  const ui: Plugin.Context["ui"] = {
    dialog: { clear: () => void dialogClears.push("clear") },
    router: { navigate: (destination) => void routerCalls.push(destination) },
    slot: (claim) => {
      claims.push(claim);
      if ("append" in claim && claim.append === "sidebar.content") {
        sidebarRender = (input) => claim.render(input);
      } else if ("append" in claim && claim.append === "app") {
        appRender = () => claim.render({});
      }
      return () => {};
    },
  };

  const keymapLayers: Plugin.KeymapLayer[] = [];
  const keymap: Plugin.Context["keymap"] = {
    layer: (input) => void keymapLayers.push(input()),
  };

  const storageKeys: string[] = [];
  const storageInitials: unknown[] = [];
  const storageWrites: unknown[] = [];
  const persistedCollapsed =
    isRecord(options.persisted) && typeof options.persisted["collapsed"] === "boolean"
      ? options.persisted["collapsed"]
      : undefined;
  const [collapsed, setCollapsed] = createSignal<boolean | undefined>(persistedCollapsed);

  let mutationsDeferred = false;
  let mutationError: string | undefined;
  const pendingMutations: Array<() => void> = [];

  const storage: Plugin.Storage = {
    store<Value extends object>(key: string, input: { readonly initial: Value }) {
      storageKeys.push(key);
      storageInitials.push(input.initial);
      // Only a store whose shape declares `collapsed` is merged with the
      // persisted value, so malformed input reaches the plugin untouched.
      const tracksCollapsed = Object.hasOwn(input.initial, "collapsed");
      const seed = { ...input.initial };
      if (tracksCollapsed && isRecord(options.persisted))
        Reflect.set(seed, "collapsed", options.persisted["collapsed"]);
      const [state, setState] = createStore<Value>(seed);
      const apply = (mutation: (draft: Value) => void): void => {
        setState(produce(mutation));
        if (!tracksCollapsed) return;
        const value: unknown = Reflect.get(state, "collapsed");
        storageWrites.push(value);
        if (typeof value === "boolean") setCollapsed(value);
      };
      const commit = async (mutation: (draft: Value) => void): Promise<void> => {
        if (mutationError) throw new Error(mutationError);
        apply(mutation);
      };
      const mutate = (mutation: (draft: Value) => void): Promise<void> => {
        if (!mutationsDeferred) return commit(mutation);
        return new Promise<void>((resolve, reject) => {
          pendingMutations.push(() => {
            commit(mutation).then(resolve, reject);
          });
        });
      };
      return [state, mutate] as const;
    },
  };

  const context: Plugin.Context = {
    theme: theme(),
    client,
    data,
    storage,
    keymap,
    ui,
  };

  return {
    context,
    claims,
    keymapLayers,
    storageKeys,
    storageInitials,
    storageWrites,
    routerCalls,
    dialogClears,
    syncCalls,
    listInputs,
    collapsed,
    sidebar: (sessionID) => {
      if (!sidebarRender) throw new Error("plugin did not register a sidebar.content slot");
      return sidebarRender({ sessionID });
    },
    app: () => {
      if (!appRender) throw new Error("plugin did not register an app slot");
      return appRender();
    },
    addSession: (init, status) => {
      known.set(init.id, init);
      store(init, status);
    },
    unsynced: (init) => known.set(init.id, init),
    orphan,
    setStatus: (id, status) => setSessions("statuses", id, status),
    setMessages: (id, messages) => setSessions("messages", id, messages),
    setListError: (message) => {
      listError = message;
    },
    emit: (event) => {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
    subscriptionCount: () => subscriptions,
    deferLists: (enabled) => {
      listsDeferred = enabled;
    },
    pendingListCount: () => pendingLists.length,
    releaseLists: async (count = 1) => {
      for (let released = 0; released < count; released += 1) {
        const next = pendingLists.shift();
        if (!next) return;
        next.resolve();
        await tick();
      }
    },
    deferSync: (enabled) => {
      syncDeferred = enabled;
    },
    syncInFlight: () => syncInFlight,
    syncMaxInFlight: () => syncMaxInFlight,
    releaseSync: async () => {
      for (let guard = 0; guard < 1_000; guard += 1) {
        const next = pendingSync.shift();
        if (!next) return;
        next();
        await tick();
      }
    },
    deferMutations: (enabled) => {
      mutationsDeferred = enabled;
    },
    pendingMutationCount: () => pendingMutations.length,
    failMutations: (message) => {
      mutationError = message;
    },
    flushMutations: async () => {
      for (let guard = 0; guard < 1_000; guard += 1) {
        const next = pendingMutations.shift();
        if (!next) {
          await tick();
          if (pendingMutations.length === 0) return;
          continue;
        }
        next();
        await tick();
      }
    },
  };
}
