package main

// browser_ax.go — CDP accessibility-tree surface provider (Phase 1 browser
// spike). Unlike the querySelectorAll-index snapshot in browser.go, this
// reads Chrome's own accessibility tree (ARIA + HTML semantics) and
// addresses elements by CDP backendDOMNodeId plus a durable SemanticRef
// (path/ordinal/sig), so actions cannot silently hit a different element
// after the DOM shifts, and stored refs survive relayouts.

import (
	"encoding/json"
	"fmt"
	"time"
)

// axValue is CDP's { value: ... } wrapper used across AXNode fields.
type axValue struct {
	Value json.RawMessage `json:"value"`
}

func (v *axValue) str() string {
	if v == nil || v.Value == nil {
		return ""
	}
	var s string
	if json.Unmarshal(v.Value, &s) == nil {
		return s
	}
	return string(v.Value)
}

type axNode struct {
	NodeID           string   `json:"nodeId"`
	Ignored          bool     `json:"ignored"`
	Role             *axValue `json:"role"`
	Name             *axValue `json:"name"`
	Value            *axValue `json:"value"`
	BackendDOMNodeID int64    `json:"backendDOMNodeId"`
	ParentID         string   `json:"parentId"`
	ChildIDs         []string `json:"childIds"`
	Properties       []axProp `json:"properties"`
}

type axProp struct {
	Name  string   `json:"name"`
	Value *axValue `json:"value"`
}

// axInteractiveRoles are roles that are worth emitting even without a name,
// and that carry actions.
var axInteractiveRoles = map[string]bool{
	"button": true, "link": true, "textbox": true, "searchbox": true,
	"checkbox": true, "radio": true, "combobox": true, "listbox": true,
	"menuitem": true, "menuitemcheckbox": true, "menuitemradio": true,
	"tab": true, "switch": true, "slider": true, "spinbutton": true,
	"option": true, "textfield": true, "MenuListOption": true,
}

// axStructuralRoles appear in ancestry paths but are not emitted themselves
// unless named.
var axIgnoredRoles = map[string]bool{
	"none": true, "generic": true, "InlineTextBox": true, "LineBreak": true,
	"StaticText": false, // emitted when named — text is context the model needs
}

const axMaxElements = 300
const axMaxPathDepth = 6

// makeBrowserAXSnapshotHandler returns the accessibility-tree snapshot:
// a filtered, interactable-first element list with durable refs.
func makeBrowserAXSnapshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		raw, err := cdp.send("Accessibility.getFullAXTree", nil)
		if err != nil {
			return nil, fmt.Errorf("getFullAXTree failed: %w", err)
		}
		var tree struct {
			Nodes []axNode `json:"nodes"`
		}
		if err := json.Unmarshal(raw, &tree); err != nil {
			return nil, fmt.Errorf("parse AX tree: %w", err)
		}

		pageInfo, _ := cdp.evalJSON(`JSON.stringify({url: location.href, title: document.title})`)

		elements := buildAXElements(tree.Nodes)

		return &RPCResult{Result: map[string]any{
			"provider":      "cdp",
			"url":           pageInfo["url"],
			"title":         pageInfo["title"],
			"element_count": len(elements),
			"elements":      elements,
			"captured_at":   time.Now().UnixMilli(),
		}}, nil
	}
}

// buildAXElements converts the flat AX node list into emitted elements with
// path/ordinal/sig refs. Interactive or named nodes only, capped.
func buildAXElements(nodes []axNode) []map[string]any {
	byID := make(map[string]*axNode, len(nodes))
	for i := range nodes {
		byID[nodes[i].NodeID] = &nodes[i]
	}

	// Ancestry path per node (root-first), capped depth, skipping unnamed
	// generic wrappers to keep paths meaningful.
	pathOf := func(n *axNode) []map[string]any {
		var rev []map[string]any
		for cur := byID[n.ParentID]; cur != nil; cur = byID[cur.ParentID] {
			role := cur.Role.str()
			name := cur.Name.str()
			if role == "" || (axIgnoredRoles[role] && name == "") {
				continue
			}
			if len(name) > 40 {
				name = name[:40]
			}
			rev = append(rev, map[string]any{"role": role, "name": name})
			if len(rev) >= axMaxPathDepth {
				break
			}
		}
		// reverse to root-first
		for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
			rev[i], rev[j] = rev[j], rev[i]
		}
		return rev
	}

	// Ordinals among same-parent siblings with equal role+name.
	ordCount := map[string]int{}
	ordinalOf := func(n *axNode) int {
		key := n.ParentID + "|" + n.Role.str() + "|" + n.Name.str()
		ord := ordCount[key]
		ordCount[key]++
		return ord
	}

	// Collect all emittable elements first, then cap. The cap must NOT be applied
	// in raw tree order — on a big page (Gmail inbox + open compose dialog) the
	// actionable fields can sit past the first N nodes and get truncated, so the
	// agent "opens compose but can't find the To field". Keep every interactive
	// element; cap only the static-text context.
	var interactiveEls, contextEls []map[string]any
	for i := range nodes {
		n := &nodes[i]
		if n.Ignored {
			continue
		}
		// Skip nodes with no backing DOM node: they cannot be clicked,
		// set_value'd, or box-modeled (DOM.resolveNode/getBoxModel fail with
		// "No node with given id found"), so emitting them only creates
		// un-actionable targets. Gmail's compose exposes such AX-only wrapper
		// nodes named "To"/"Subject" alongside the real editable fields.
		if n.BackendDOMNodeID == 0 {
			continue
		}
		role := n.Role.str()
		name := n.Name.str()
		interactive := axInteractiveRoles[role]
		if !interactive && name == "" {
			continue
		}
		if axIgnoredRoles[role] && name == "" {
			continue
		}
		ord := ordinalOf(n)

		if len(name) > 100 {
			name = name[:100]
		}
		path := pathOf(n)
		stableID := fmt.Sprintf("%d", n.BackendDOMNodeID)
		el := map[string]any{
			"ax_id":           n.NodeID,
			"backend_node_id": n.BackendDOMNodeID,
			"role":            role,
			"name":            name,
			"interactive":     interactive,
			"path":            path,
			"ordinal":         ord,
			"sig":             semanticSig(role, name, "", path, ord),
			"stable_id":       stableID,
		}
		if v := n.Value.str(); v != "" {
			el["value"] = v
		}
		for _, p := range n.Properties {
			switch p.Name {
			case "disabled", "focused", "expanded", "checked", "selected":
				el[p.Name] = json.RawMessage(p.Value.Value)
			}
		}
		if interactive {
			interactiveEls = append(interactiveEls, el)
		} else {
			contextEls = append(contextEls, el)
		}
	}

	// All interactive elements, plus as much named-text context as fits.
	out := interactiveEls
	if budget := axMaxElements - len(out); budget > 0 {
		if budget > len(contextEls) {
			budget = len(contextEls)
		}
		out = append(out, contextEls[:budget]...)
	}
	return out
}

// makeBrowserAXClickHandler clicks an element by backend_node_id: scroll it
// into view, resolve its box, and dispatch a real mouse click at its center.
// Element-addressed — immune to the index-shift problem of browser_click.
func makeBrowserAXClickHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		backendID, ok := params["backend_node_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: backend_node_id (from browser_ax_snapshot)")
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		// Best effort; a hidden element will fail at the box-model step with
		// a precise error.
		_, _ = cdp.send("DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": int64(backendID)})

		raw, err := cdp.send("DOM.getBoxModel", map[string]any{"backendNodeId": int64(backendID)})
		if err != nil {
			return nil, fmt.Errorf("element %d has no layout box — it is detached or hidden; take a fresh browser_ax_snapshot: %w", int64(backendID), err)
		}
		var box struct {
			Model struct {
				Content []float64 `json:"content"`
			} `json:"model"`
		}
		if err := json.Unmarshal(raw, &box); err != nil || len(box.Model.Content) < 8 {
			return nil, fmt.Errorf("could not read element %d box model", int64(backendID))
		}
		// content quad: x1,y1,x2,y2,x3,y3,x4,y4
		cx := (box.Model.Content[0] + box.Model.Content[4]) / 2
		cy := (box.Model.Content[1] + box.Model.Content[5]) / 2

		for _, evType := range []string{"mousePressed", "mouseReleased"} {
			if _, err := cdp.send("Input.dispatchMouseEvent", map[string]any{
				"type": evType, "x": cx, "y": cy,
				"button": "left", "clickCount": 1,
			}); err != nil {
				return nil, fmt.Errorf("click dispatch failed: %w", err)
			}
		}

		return &RPCResult{Result: map[string]any{
			"success":         true,
			"backend_node_id": int64(backendID),
			"clicked_at":      map[string]any{"x": cx, "y": cy},
		}}, nil
	}
}

// makeBrowserAXSetValueHandler sets a form control's value by
// backend_node_id via the DOM node itself (focus + value + input/change
// events), reading the value back for verification.
func makeBrowserAXSetValueHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		backendID, ok := params["backend_node_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: backend_node_id (from browser_ax_snapshot)")
		}
		value, hasValue := params["value"].(string)
		if !hasValue {
			return nil, fmt.Errorf("missing required parameter: value")
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		raw, err := cdp.send("DOM.resolveNode", map[string]any{"backendNodeId": int64(backendID)})
		if err != nil {
			return nil, fmt.Errorf("element %d could not be resolved — it is gone; take a fresh browser_ax_snapshot: %w", int64(backendID), err)
		}
		var resolved struct {
			Object struct {
				ObjectID string `json:"objectId"`
			} `json:"object"`
		}
		if err := json.Unmarshal(raw, &resolved); err != nil || resolved.Object.ObjectID == "" {
			return nil, fmt.Errorf("element %d resolved to no object", int64(backendID))
		}

		fnRaw, err := cdp.send("Runtime.callFunctionOn", map[string]any{
			"objectId": resolved.Object.ObjectID,
			"functionDeclaration": `function(v) {
				this.focus();
				const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				const desc = Object.getOwnPropertyDescriptor(proto, 'value');
				if (desc && desc.set && (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA')) {
					desc.set.call(this, v);
				} else if (this.isContentEditable) {
					this.textContent = v;
				} else {
					this.value = v;
				}
				this.dispatchEvent(new Event('input', {bubbles: true}));
				this.dispatchEvent(new Event('change', {bubbles: true}));
				return JSON.stringify({value: this.value !== undefined ? this.value : this.textContent, tag: this.tagName});
			}`,
			"arguments":     []map[string]any{{"value": value}},
			"returnByValue": true,
		})
		if err != nil {
			return nil, fmt.Errorf("set_value failed: %w", err)
		}
		var fnRes struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
			ExceptionDetails *struct {
				Text string `json:"text"`
			} `json:"exceptionDetails"`
		}
		_ = json.Unmarshal(fnRaw, &fnRes)
		if fnRes.ExceptionDetails != nil {
			return nil, fmt.Errorf("set_value threw in page: %s", fnRes.ExceptionDetails.Text)
		}
		verify := map[string]any{}
		_ = json.Unmarshal([]byte(fnRes.Result.Value), &verify)

		return &RPCResult{Result: map[string]any{
			"success":         true,
			"backend_node_id": int64(backendID),
			"readback":        verify,
		}}, nil
	}
}
