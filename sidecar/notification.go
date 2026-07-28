package main

import "sync/atomic"

// Outbound OS notifications (design: usejarvis-tray.html §01). The brain
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
	// notifyEmitActionV sends the user's choice back to the brain as a
	// `notify.action` event. Set by the client once its connection exists.
	// atomic.Value because connectAndServe re-assigns it on every reconnect while
	// the tray/Cocoa threads read it — a plain var is a data race. Use
	// notifyEmitAction()/setNotifyEmitAction(), never the var directly.
	notifyEmitActionV atomic.Value // func(id, kind, action string)
	// setupNotifications registers the platform bits notifications need (Windows:
	// the AUMID + jarvis:// URI scheme). Called once at startup; no-op elsewhere.
	setupNotifications = func() {}
	// maybeForwardProtocolLaunch handles the case where this process was launched
	// by the OS to service a notification-button click (a jarvis:// URI in argv):
	// it forwards the action to the already-running sidecar and returns true so
	// main exits without booting a second instance. Returns false on a normal
	// launch. No-op (false) on platforms without protocol-activated notifications.
	maybeForwardProtocolLaunch = func() bool { return false }
)

func notifyEmitAction(id, kind, action string) {
	if f, ok := notifyEmitActionV.Load().(func(string, string, string)); ok && f != nil {
		f(id, kind, action)
	}
}

func setNotifyEmitAction(f func(id, kind, action string)) { notifyEmitActionV.Store(f) }

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
