package main

import (
	"context"
	"errors"
	"log"
	"sync/atomic"
	"time"
)

// Outbound OS notifications (design: usejarvis-tray.html §01). The brain
// decides WHEN to interrupt — the five reasons Jarvis is allowed to: it needs
// your OK (approval), it finished something (done), a machine dropped (sidecar),
// an update is ready (update), or a hosted plan's included AI usage is running
// low or spent (usage) — and pushes a `notify.show` RPC. The sidecar
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
	Kind        string // approval | approval_review | done | sidecar | update | usage | workflow
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
	notifyEmitActionV atomic.Value // func(id, kind, action string) error
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

// errNotifyNotConnected is what an emit reports before the client has a
// connection to send it on.
var errNotifyNotConnected = errors.New("not connected to the brain")

func notifyEmitAction(id, kind, action string) error {
	if f, ok := notifyEmitActionV.Load().(func(string, string, string) error); ok && f != nil {
		return f(id, kind, action)
	}
	return errNotifyNotConnected
}

func setNotifyEmitAction(f func(id, kind, action string) error) { notifyEmitActionV.Store(f) }

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

// notifyActionOpensChat reports whether a notification action is one that
// only opens the app (#853). Approve/Deny act on the brain from the
// notification itself; Dismiss/Later do nothing. The brain ignores the
// open-the-app actions because the sidecar handles them (src/daemon/index.ts,
// the notify.action handler), so a platform that forgot to open the chat left
// the tap doing nothing at all, which is what macOS did before this.
func notifyActionOpensChat(action string) bool {
	switch action {
	case "review", "view", "reconnect", "restart":
		return true
	}
	return false
}

// dispatchNotifyAction is what every platform does with a notification tap:
// tell the brain (so it can act on approve/deny and mark the rest seen), then
// open the chat for the open-the-app actions. openChat is the platform's
// tray hook; nil (the tray is not up yet) opens nothing.
//
// Nothing here runs on the caller's thread. The callers are UI threads (the
// Cocoa main thread, the Windows message loop): openChat mints a panel token
// (a network round trip), and the emit is a WebSocket write that a wedged
// brain connection can hold up for as long as the connection lives (#1160).
// The emit goes through trayCtlAsync, the serialized worker the tray's own
// pause/mute writes use, so two quick taps still reach the brain in order.
//
// The write is bounded (sendUIEvent), so an Approve or Deny can fail to reach
// the brain: a wedged connection, or a slow uplink busy with a large frame for
// longer than the bound. The decision is then not made, and the approval is
// still pending; the chat opens so the person sees that and decides there,
// rather than believing the tap took.
func dispatchNotifyAction(id, kind, action string, openChat func()) {
	trayCtlAsync(func() {
		if err := notifyEmitAction(id, kind, action); err != nil && notifyActionDecides(action) {
			log.Printf("[notify] %s for %q did not reach the brain (%v); opening Jarvis to decide there", action, id, err)
			if openChat != nil {
				go openChat()
			}
		}
	})
	if openChat != nil && notifyActionOpensChat(action) {
		go openChat()
	}
}

// notifyActionDecides reports whether an action is a decision made from the
// notification itself.
func notifyActionDecides(action string) bool { return action == "approve" || action == "deny" }

// uiEventWriteTimeout bounds one small event written to the brain on behalf of
// a click in the tray or on a notification. A healthy socket takes the write
// at once; a wedged one (a brain that stopped reading, a half-dead TCP path)
// would otherwise hold it for as long as the connection lives, and these
// writes share one serialized worker (trayCtlAsync), so one stuck write held
// every later tap and toggle behind it (#1160). 5s is the bound the realtime
// channel's keepalive already puts on its own writes (client.go). A write that
// runs out of time mid-frame makes the websocket library close the whole
// connection, and the client reconnects: right for a wedged socket, and the
// price on a merely slow one.
const uiEventWriteTimeout = 5 * time.Second

// sendUIEvent writes one tray or notification event with that bound. Every
// caller passes Background: the bound is what ends a stuck write, and a write
// on a connection already closed fails at once.
func sendUIEvent(ctx context.Context, send func(context.Context, SidecarEvent) error, eventType string, payload map[string]any) error {
	wctx, cancel := context.WithTimeout(ctx, uiEventWriteTimeout)
	defer cancel()
	err := send(wctx, SidecarEvent{
		EventType: eventType,
		Timestamp: time.Now().UnixMilli(),
		Priority:  "normal",
		Payload:   payload,
	})
	if err != nil {
		log.Printf("[tray] %s was not delivered to the brain: %v", eventType, err)
	}
	return err
}
