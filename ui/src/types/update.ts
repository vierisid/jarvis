export type UpdateInfo = {
  current_version: string;
  latest_version: string | null;
  latest_url: string | null;
  latest_published_at: string | null;
  has_update: boolean;
  update_status: string;
  update_message: string;
  check_error: string | null;
  last_checked_at: string | null;
};
