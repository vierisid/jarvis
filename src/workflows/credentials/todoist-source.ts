import type { JarvisConfig } from "../../config/types";
import {
  TODOIST_CONNECTION,
  TODOIST_PIECE,
  readTodoistConnection,
} from "../../integrations/todoist-connection";
import {
  freshTodoistConnection,
  todoistGrantKey,
  todoistNeedsReconnect,
} from "../../integrations/todoist-refresh";
import { MANAGED_TODOIST_ACTIONS } from "../runtime/managed-todoist";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisTodoistConnectionSource implements JarvisConnectionSource {
  readonly id = "todoist";
  readonly pieceNames = [TODOIST_PIECE];
  readonly pieceDetails = {
    [TODOIST_PIECE]: {
      displayName: "Todoist",
      apiHosts: ["api.todoist.com"],
      actions: MANAGED_TODOIST_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === TODOIST_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readTodoistConnection(this.config.daemon.data_dir)
      : null;
    return c && !todoistNeedsReconnect(this.config, c)
      ? todoistGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readTodoistConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshTodoistConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: TODOIST_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",

        jarvis_managed: "todoist",
      },
    };
  }
}
