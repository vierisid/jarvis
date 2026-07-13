package main

// Outbound OS notifications (design: usejarvis-tray-FABLE5.html §01). The brain
// decides WHEN to interrupt — the four reasons Jarvis is allowed to: it needs
// your OK (approval), it finished something (done), a machine dropped (sidecar),
// or an update is ready (update) — and pushes a `notify.show` RPC. The sidecar
// raises the native notification; a click (or an action button, where the
// platform supports them) emits `notify.action` back so the brain can act.
//
// Candor (Authority Book 08): approving from an OS notification is a deliberate
// click on your own trusted machine, so Approve/Deny is allowed for ordinary
// external actions. Destructive (irreversible) actions carry only "Review in
// Jarvis" and open the app — the click-only-in-app rule still holds. The brain
// sets Destructive + the action set accordingly; the sidecar just renders it.

type NotifyAction struct {
	ID      string // approve | deny | review | view | dismiss | reconnect | restart | later
	Label   string
	Primary bool
}

type Notification struct {
	ID          string // approval id, or a synthetic id for done/sidecar/update
	Kind        string // approval | done | sidecar | update
	Title       string
	Body        string
	Meta        string // e.g. "external · send_email" (shown inline on Windows)
	Actions     []NotifyAction
	Destructive bool
}

var (
	// showNotification renders a Notification natively. Set by the platform tray
	// (Windows balloon / macOS card); no-op on platforms without a tray.
	showNotification = func(n Notification) {}
	// notifyEmitAction sends the user's choice back to the brain as a
	// `notify.action` event. Set by the client once its connection exists.
	notifyEmitAction = func(id, kind, action string) {}
)

// notificationFromParams decodes a `notify.show` RPC payload.
func notificationFromParams(params map[string]any) Notification {
	n := Notification{}
	if v, ok := params["id"].(string); ok {
		n.ID = v
	}
	if v, ok := params["kind"].(string); ok {
		n.Kind = v
	}
	if v, ok := params["title"].(string); ok {
		n.Title = v
	}
	if v, ok := params["body"].(string); ok {
		n.Body = v
	}
	if v, ok := params["meta"].(string); ok {
		n.Meta = v
	}
	if v, ok := params["destructive"].(bool); ok {
		n.Destructive = v
	}
	if arr, ok := params["actions"].([]any); ok {
		for _, it := range arr {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			a := NotifyAction{}
			if s, ok := m["id"].(string); ok {
				a.ID = s
			}
			if s, ok := m["label"].(string); ok {
				a.Label = s
			}
			if b, ok := m["primary"].(bool); ok {
				a.Primary = b
			}
			n.Actions = append(n.Actions, a)
		}
	}
	return n
}
