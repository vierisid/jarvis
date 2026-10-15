/** Browser-safe F-05 bounds and references. Bytes never travel over chat WebSocket. */
export type BriefAttachmentKind = 'document' | 'image' | 'screenshot';
export interface BriefAttachmentRef {
  attachmentId: string;
  conversationId: string;
  kind: BriefAttachmentKind;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  expiresAt: number;
  state: 'ready' | 'accepted' | 'removed' | 'expired';
  turnId: string | null;
}
export const ATTACHMENT_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  documentBytes: 1024 * 1024,
  textChars: 128_000,
  imagePixels: 8_000_000,
  pdfPages: 40,
  perTurn: 4,
  turnBytes: 8 * 1024 * 1024,
  workspaceBytes: 64 * 1024 * 1024,
  ttlMs: 24 * 60 * 60 * 1000,
} as const;
