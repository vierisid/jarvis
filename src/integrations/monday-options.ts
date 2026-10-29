import type { JarvisConfig } from "../config/types";
import { freshMondayConnection } from "./monday-refresh";
import {
  mondayBoard,
  mondayGraphql,
  mondayId,
} from "../workflows/runtime/managed-monday";
/** Bounded setup choices from the same renewed grant used for execution. */
export async function mondayOptions(
  config: JarvisConfig,
  kind: "boards" | "groups" | "columns",
  board: string | null,
  cursor: string | null,
  request: typeof fetch = fetch,
) {
  if (cursor && !/^[1-9][0-9]{0,3}$/.test(cursor))
    throw Error("Invalid monday.com page.");
  if (kind !== "boards" && !board) return { options: [], next_cursor: null };
  if (board) mondayId(board);
  const c = await freshMondayConnection(config, request);
  if (kind === "boards") {
    const page = cursor ? Number(cursor) : 1;
    const d = await mondayGraphql(
      c.access_token,
      "query JarvisBoards($page: Int!) { boards(limit: 100, page: $page, state: active) { id name } }",
      { page },
      request,
    );
    if (!Array.isArray(d.boards) || d.boards.length > 100)
      throw Error("monday.com returned invalid boards.");
    const options = d.boards.map((v: any) => {
      if (typeof v.name !== "string") throw Error("Invalid board name.");
      return { value: mondayId(v.id), label: v.name.slice(0, 200) };
    });
    return {
      options,
      next_cursor: options.length === 100 ? String(page + 1) : null,
    };
  }
  if (cursor) throw Error("These choices do not accept a page.");
  const meta = await mondayBoard(c.access_token, board!, request);
  const values = kind === "groups" ? meta.groups : meta.columns;
  if (values.length > 1000)
    throw Error("Too many board choices. Enter the ID directly.");
  return {
    options: values.map((v: any) => {
      if (
        typeof v.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(v.id) ||
        typeof v.title !== "string" ||
        (kind === "columns" && typeof v.type !== "string")
      )
        throw Error("Invalid board choice.");
      return {
        value: v.id,
        label: v.title.slice(0, 200),
        ...(kind === "columns" ? { type: v.type } : {}),
      };
    }),
    next_cursor: null,
  };
}
