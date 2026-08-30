/**
 * Shape returned by `GET /api/palette/search`. Mirrors the daemon-side
 * `PaletteResult` in `src/daemon/api-routes.ts`. Designed to map directly
 * onto `<InlineCard>` props when the user picks an object result.
 */
export type PaletteResultType =
  | "workflow"
  | "memory"
  | "tool"
  | "agent"
  | "authority"
  | "log";

export type PaletteResult = {
  type: PaletteResultType;
  id: string;
  ref: string;
  title: string;
  summary?: string;
  meta?: string;
  status?: { label: string; tone: "ok" | "warn" | "neutral" | "accent" };
};

/**
 * Room navigation entries shown in the palette when the query is empty
 * or matches a Room name. Selecting one opens the Room (Phase 6 stub for
 * now). The `key` becomes the navigation route; the `label` matches the
 * Room build order from the roadmap.
 */
export type PaletteNavEntry = {
  key:
    | "tools"
    | "logs"
    | "agents"
    | "workflows"
    | "memory"
    | "authority"
    | "calendar"
    | "goals"
    | "tasks"
    | "content"
    | "workspaces"
    | "usage"
    | "settings";
  label: string;
  hint: string;
};

export const ROOM_NAV_ENTRIES: PaletteNavEntry[] = [
  { key: "workflows", label: "ワークフロー", hint: "保存したAIフローの実行と編集" },
  { key: "memory", label: "メモリー", hint: "JARVISが記憶している情報" },
  { key: "agents", label: "エージェント", hint: "担当・状態・直近の実行" },
  { key: "authority", label: "権限と承認", hint: "操作範囲・許可リスト・承認" },
  { key: "tools", label: "ツール", hint: "利用可能な機能と設定" },
  { key: "logs", label: "アクティビティ", hint: "絞り込み可能なイベント履歴" },
  { key: "calendar", label: "カレンダー", hint: "今週の予定とコミットメント" },
  { key: "goals", label: "ゴール", hint: "目標の階層と進捗スコア" },
  { key: "tasks", label: "タスク", hint: "期限・優先度・進行状況" },
  { key: "content", label: "コンテンツ", hint: "下書き・予約・公開済み" },
  { key: "workspaces", label: "ワークスペース", hint: "開発プロジェクトとGit状態" },
  { key: "usage", label: "使用状況", hint: "モデル別のLLM利用状況" },
  { key: "settings", label: "設定", hint: "AI・音声・ショートカット" },
];

/**
 * Map a palette Room nav key to the `ObjectType` used by `<InlineCard>`.
 * 1:1 except `workflows` → `workflow`, `agents` → `agent`, `logs` → `log`.
 */
export function navKeyToObjectType(
  key: PaletteNavEntry["key"],
):
  | "workflow"
  | "memory"
  | "tool"
  | "agent"
  | "authority"
  | "log"
  | "calendar"
  | "goals"
  | "tasks"
  | "content"
  | "workspaces"
  | "usage"
  | "settings" {
  switch (key) {
    case "workflows":
      return "workflow";
    case "agents":
      return "agent";
    case "logs":
      return "log";
    case "tools":
      return "tool";
    default:
      return key;
  }
}
