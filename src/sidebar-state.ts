export const PLUGIN_ID = "opencode-subagent-watch";
export const COLLAPSED_KEY = `${PLUGIN_ID}.collapsed`;
export const DEFAULT_COLLAPSED = true;
export const SIDEBAR_ORDER = 60;

type KVReader = {
  get<T>(key: string, fallback: T): T;
};

export function restoreCollapsed(kv: KVReader): boolean {
  return kv.get<boolean>(COLLAPSED_KEY, DEFAULT_COLLAPSED);
}
