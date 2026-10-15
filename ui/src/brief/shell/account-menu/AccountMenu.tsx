import React from "react";
import { CreditCard, Settings2, UserRound } from "lucide-react";
import { BriefMenu, type BriefMenuItem } from "../../components/controls";
import type { BriefRoomId, BriefShellPort } from "../../contracts";
import { briefHash } from "../../entry/route";
import { initials, planLabel, type BriefAccount } from "../navigation/model";

const ITEMS = [
  { room: "profile", label: "Profile", Icon: UserRound },
  { room: "settings", label: "Settings", Icon: Settings2 },
  { room: "billing", label: "Billing", Icon: CreditCard },
] as const;

/** One account origin, including avatar/name/plan, in either sidebar width.
 * It only navigates between Brief rooms; it reads no account API and performs no account action. */
export function AccountMenu({ shell, account, rail }: { shell: BriefShellPort; account: BriefAccount; rail: boolean }) {
  const name = account.name?.trim() || "Your account";
  const plan = planLabel(account.plan);
  const select = (room: BriefRoomId) => { if (shell.route.room !== room) shell.navigate({ room, selection: {} }); };
  const items: BriefMenuItem[] = ITEMS.map(({ room, label, Icon }) => ({
    id: room, label, icon: <Icon size={16} strokeWidth={1.6} />, current: shell.route.room === room, onSelect: () => select(room),
  }));
  return <BriefMenu label="Account" items={items} className="brief-account-menu"
    placement={rail ? "right-end" : "top-start"} reveal={rail ? "left" : "up"}
    // Browser Back, deep links and future voice navigation also dismiss the menu.
    dismissKey={briefHash(shell.route)}
    trigger={props => <button {...props} type="button" className="brief-account-origin" aria-label={`${name}, ${plan}. Account menu`}>
      <span className="brief-account-avatar" aria-hidden="true">{initials(account.name)}</span>
      <span className="brief-account-copy" aria-hidden={rail}><strong>{name}</strong><span title={plan}>{plan}</span></span>
    </button>} />;
}
