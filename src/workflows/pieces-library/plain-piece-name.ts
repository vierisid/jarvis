/**
 * A piece or action named the way a person says it. Used where only the
 * package or the internal action name is known, as for a piece that has been
 * removed: `@activepieces/piece-google-sheets` reads "Google Sheets",
 * `send_channel_message` reads "Send channel message". Pure, so the dashboard
 * and the failure sentences share it.
 */
const WORD_FIXES: Readonly<Record<string, string>> = { ai: "AI", api: "API", crm: "CRM", csv: "CSV", http: "HTTP", sms: "SMS", url: "URL" };

function words(slug: string): string[] {
  return slug
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

export function plainPieceName(pieceName: string): string {
  const slug = pieceName.replace(/^@[^/]+\//, "").replace(/^piece-/, "");
  const parts = words(slug).map((word) => WORD_FIXES[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1));
  return parts.length ? parts.join(" ") : "an unknown";
}

export function plainActionName(actionName: string): string {
  const parts = words(actionName).map((word, index) => WORD_FIXES[word.toLowerCase()] ?? (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()));
  return parts.join(" ");
}
