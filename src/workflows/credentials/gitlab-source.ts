import type { JarvisConfig } from "../../config/types";
import {
  GITLAB_CONNECTION,
  GITLAB_PIECE,
  readGitLabConnection,
} from "../../integrations/gitlab-connection";
import {
  freshGitLabConnection,
  gitlabGrantKey,
  gitlabNeedsReconnect,
} from "../../integrations/gitlab-refresh";
import { MANAGED_GITLAB_ACTIONS } from "../runtime/managed-gitlab";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisGitLabConnectionSource implements JarvisConnectionSource {
  readonly id = "gitlab";
  readonly pieceNames = [GITLAB_PIECE];
  readonly pieceDetails = {
    [GITLAB_PIECE]: {
      displayName: "GitLab",
      apiHosts: ["gitlab.com"],
      actions: MANAGED_GITLAB_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === GITLAB_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readGitLabConnection(this.config.daemon.data_dir)
      : null;
    return c && !gitlabNeedsReconnect(this.config, c)
      ? gitlabGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readGitLabConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshGitLabConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: GITLAB_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "gitlab",
        jarvis_user: c.account.id,
      },
    };
  }
}
