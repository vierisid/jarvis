/**
 * Suggestions go to the count.
 *
 * When Jarvis notices something worth saying (awareness, and the opportunity
 * outbox behind it), the product raises a toast on the brain's own machine
 * and, with a dashboard open, says it aloud. With the notch on, neither
 * happens: the suggestion joins the count, quietly, and is said in the next
 * round. Nothing pops up over what the person is doing, and nothing is
 * spoken that was not asked for.
 *
 * This stands in for the two toast senders the delivery policy is given
 * (daemon/awareness-delivery-policy.ts). It changes nothing else about
 * delivery: the dashboard card, the chat line and the feedback routes are as
 * they were, and so is every toast that is not a suggestion.
 *
 * A suggestion is news here: said once, asking nothing. Acting on one is
 * still done on its card in the dashboard.
 */
import type { NotchInbox } from './inbox.ts';
import type { NotchPart } from './protocol.ts';

/** The most of a suggestion's body one line carries after its title. */
const BODY_CHARS = 110;

export interface NotchSuggestions {
  /** In place of the fire-and-forget toast. True, as a toast that was launched answers. */
  toast(title: string, body: string): boolean;
  /** In place of the toast that reports whether it was shown. In the count counts as shown. */
  toastWithReceipt(title: string, body: string): Promise<'shown'>;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number): string => {
  const points = [...oneLine(text)];
  return points.length <= max ? points.join('') : `${points.slice(0, max - 1).join('').trimEnd()}…`;
};

export function attachNotchSuggestions(inbox: NotchInbox): NotchSuggestions {
  let n = 0;
  const add = (rawTitle: string, rawBody: string): void => {
    // The policy titles its toasts "JARVIS: <title>". On the notch it is Jarvis speaking already.
    const title = oneLine(rawTitle).replace(/^JARVIS:\s*/i, '') || 'A suggestion';
    const body = cut(rawBody, BODY_CHARS);
    const say: NotchPart[] = body && body !== title ? [`${title}: `, { em: body }] : [title];
    inbox.add({
      id: `suggestion:${++n}`,
      // The same suggestion made again takes the place of the first.
      subject: `suggestion:${title.toLowerCase()}`,
      class: 'rest',
      // It does not speak up: that is the point. It waits to be asked.
      speaks: false,
      once: true,
      title: () => [title],
      play: async (stage) => {
        await stage.say(say, 6500, { mood: 'curious' });
        return 'settled';
      },
    });
  };
  return {
    toast: (title, body) => { add(title, body); return true; },
    toastWithReceipt: async (title, body) => { add(title, body); return 'shown'; },
  };
}
