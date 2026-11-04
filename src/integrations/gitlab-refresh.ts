import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readGitLabConnection } from "./gitlab-connection";
const refresh = createManagedRotatingRefresher(
  "gitlab",
  "GitLab",
  readGitLabConnection,
);
export const freshGitLabConnection = refresh.fresh;
export const gitlabNeedsReconnect = refresh.needsReconnect;
export const gitlabGrantKey = refresh.grantKey;
