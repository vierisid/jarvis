import type { EditableProfile, ProfilePatch, ProfileSettingsSnapshot } from '../../../../src/brief/profile-settings-contracts';
import type { UserProfileQuestionId } from '../../../../src/user/profile';

/** Headless consumer seam for D-29. Drafts stay local; polling never advances a dirty edit's revision. */
export class ProfileEditor {
  private base: EditableProfile | null = null;
  private draft: ProfilePatch = {};
  private generation = 0;
  private saving = false;
  constructor(private readonly ports: {
    read(): Promise<ProfileSettingsSnapshot>;
    saveProfile(revision: string, patch: ProfilePatch): Promise<EditableProfile>;
  }) {}
  current() { return { profile: this.base ? structuredClone(this.base) : null, draft: { ...this.draft }, saving: this.saving }; }
  edit(id: UserProfileQuestionId, value: string | null) {
    if (!this.base) throw new Error('Profile has not loaded');
    this.draft[id] = value;
  }
  async refresh() {
    if (this.saving) return;
    const generation = ++this.generation, snapshot = await this.ports.read();
    if (generation !== this.generation || this.saving) return;
    if (!Object.keys(this.draft).length) this.base = structuredClone(snapshot.profile);
    return snapshot;
  }
  async save() {
    if (!this.base || this.saving || !Object.keys(this.draft).length) return;
    ++this.generation; this.saving = true;
    const submitted = { ...this.draft };
    try {
      const profile = await this.ports.saveProfile(this.base.revision, submitted);
      this.base = structuredClone(profile);
      for (const key of Object.keys(submitted) as UserProfileQuestionId[]) {
        if (this.draft[key] === submitted[key]) delete this.draft[key];
      }
      return profile;
    } finally { this.saving = false; }
  }
  /** Consumer must confirm discarding local edits before invoking. Conflicts never call this automatically. */
  async discardAndReload() {
    if (this.saving) throw new Error('Save is in progress');
    this.draft = {}; return this.refresh();
  }
}
