import React, { useEffect, useMemo, useRef, useState } from "react";

type SpecialistInfo = {
  id: string;
  name: string;
  description: string;
  authority_level: number;
  tools: string[];
};

type BuilderNodeType = "trigger" | "router" | "memory" | "specialist" | "tools" | "approval" | "output";

type BuilderNode = {
  id: string;
  type: BuilderNodeType;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  accent: string;
  config: {
    connector: string;
    prompt: string;
    notes: string;
    timeoutSec: number;
    retries: number;
  };
};

type BuilderEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
};

type DragState = {
  nodeId: string;
  offsetX: number;
  offsetY: number;
};

const DEFAULT_SPECIALISTS: SpecialistInfo[] = [
  {
    id: "software-engineer",
    name: "Software Engineer",
    description: "Builds and patches code with shell, files, and browser tools.",
    authority_level: 4,
    tools: ["browser", "shell", "files"],
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Investigates topics, gathers evidence, and summarizes findings.",
    authority_level: 3,
    tools: ["browser", "files"],
  },
  {
    id: "system-administrator",
    name: "System Administrator",
    description: "Handles infra, runtime, and machine-level troubleshooting.",
    authority_level: 4,
    tools: ["shell", "files"],
  },
];

const NODE_PRESETS: Record<BuilderNodeType, Omit<BuilderNode, "id" | "x" | "y">> = {
  trigger: {
    type: "trigger",
    title: "Trigger",
    subtitle: "Manual or event start",
    accent: "#22D3EE",
    config: {
      connector: "dashboard_event",
      prompt: "Accept a user or event payload and normalize it into workflow input.",
      notes: "Start when a user event, webhook, or schedule fires.",
      timeoutSec: 15,
      retries: 0,
    },
  },
  router: {
    type: "router",
    title: "Router",
    subtitle: "Branch by task type",
    accent: "#8B5CF6",
    config: {
      connector: "intent_classifier",
      prompt: "Choose the next branch based on user intent and confidence.",
      notes: "Route the request to the right specialist or control path.",
      timeoutSec: 20,
      retries: 1,
    },
  },
  memory: {
    type: "memory",
    title: "Memory",
    subtitle: "Context preload",
    accent: "#34D399",
    config: {
      connector: "vault_context",
      prompt: "Load durable memory, recent context, and scoped knowledge before execution.",
      notes: "Hydrate the graph with goals, entities, and previous work.",
      timeoutSec: 20,
      retries: 1,
    },
  },
  specialist: {
    type: "specialist",
    title: "Specialist",
    subtitle: "Persistent worker",
    accent: "#60A5FA",
    config: {
      connector: "software-engineer",
      prompt: "Delegate the task to a focused persistent specialist.",
      notes: "Spawn or reuse a specialist with a bounded scope.",
      timeoutSec: 120,
      retries: 2,
    },
  },
  tools: {
    type: "tools",
    title: "Tools",
    subtitle: "Connector permissions",
    accent: "#FBBF24",
    config: {
      connector: "browser, shell, files",
      prompt: "Allow only the listed connectors and tools.",
      notes: "Constrain the node to the exact capabilities it needs.",
      timeoutSec: 30,
      retries: 0,
    },
  },
  approval: {
    type: "approval",
    title: "Approval",
    subtitle: "Human checkpoint",
    accent: "#FB7185",
    config: {
      connector: "authority_gate",
      prompt: "Pause and ask the operator for approval before continuing.",
      notes: "Use for sensitive actions or irreversible changes.",
      timeoutSec: 600,
      retries: 0,
    },
  },
  output: {
    type: "output",
    title: "Output",
    subtitle: "Delivery step",
    accent: "#A78BFA",
    config: {
      connector: "dashboard_response",
      prompt: "Deliver the final result to the selected output surface.",
      notes: "Send the result to dashboard, Telegram, or another endpoint.",
      timeoutSec: 30,
      retries: 1,
    },
  },
};

const CANVAS_WIDTH = 1900;
const CANVAS_HEIGHT = 1100;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 112;

export default function AgentBuilderView({ specialists }: { specialists?: SpecialistInfo[] }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<BuilderNode[]>([]);
  const [edges, setEdges] = useState<BuilderEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const specialistOptions = specialists && specialists.length > 0 ? specialists : DEFAULT_SPECIALISTS;

  const selectedNode = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;

  const selectedEdge = selectedEdgeId
    ? edges.find((edge) => edge.id === selectedEdgeId) ?? null
    : null;

  const selectedSpecialistMeta = selectedNode?.type === "specialist"
    ? specialistOptions.find((specialist) => specialist.id === selectedNode.config.connector) ?? null
    : null;

  const stats = useMemo(() => ({
    nodes: nodes.length,
    connectors: edges.length,
    specialists: nodes.filter((node) => node.type === "specialist").length,
  }), [edges.length, nodes]);

  useEffect(() => {
    if (!drag) return undefined;

    const onMove = (event: MouseEvent) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const nextX = Math.max(24, Math.min(CANVAS_WIDTH - NODE_WIDTH - 24, event.clientX - rect.left + canvasRef.current.scrollLeft - drag.offsetX));
      const nextY = Math.max(24, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 24, event.clientY - rect.top + canvasRef.current.scrollTop - drag.offsetY));
      setNodes((prev) => prev.map((node) => (
        node.id === drag.nodeId
          ? { ...node, x: nextX, y: nextY }
          : node
      )));
    };

    const onUp = () => setDrag(null);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag]);

  const addNode = (type: BuilderNodeType) => {
    const preset = NODE_PRESETS[type];
    const id = `node-${crypto.randomUUID()}`;
    const idx = nodes.length;
    const specialistId = type === "specialist" ? specialistOptions[0]!.id : preset.config.connector;
    const specialistName = type === "specialist" ? specialistOptions[0]!.name : preset.title;
    const col = idx % 4;
    const row = Math.floor(idx / 4);

    const node: BuilderNode = {
      ...preset,
      id,
      title: type === "specialist" ? specialistName : preset.title,
      x: 96 + col * 280,
      y: 100 + row * 170,
      config: {
        ...preset.config,
        connector: specialistId,
      },
    };

    setNodes((prev) => [...prev, node]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setConnectingFrom(null);
  };

  const updateSelectedNode = (updater: (node: BuilderNode) => BuilderNode) => {
    if (!selectedNode) return;
    setNodes((prev) => prev.map((node) => (node.id === selectedNode.id ? updater(node) : node)));
  };

  const updateSelectedEdge = (updater: (edge: BuilderEdge) => BuilderEdge) => {
    if (!selectedEdge) return;
    setEdges((prev) => prev.map((edge) => (edge.id === selectedEdge.id ? updater(edge) : edge)));
  };

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setConnectingFrom(null);
  };

  const deleteSelectedNode = () => {
    if (!selectedNode) return;
    setNodes((prev) => prev.filter((node) => node.id !== selectedNode.id));
    setEdges((prev) => prev.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id));
    setConnectingFrom((prev) => (prev === selectedNode.id ? null : prev));
    setSelectedNodeId(null);
  };

  const duplicateSelectedNode = () => {
    if (!selectedNode) return;
    const duplicate: BuilderNode = {
      ...selectedNode,
      id: `node-${crypto.randomUUID()}`,
      x: Math.min(selectedNode.x + 40, CANVAS_WIDTH - NODE_WIDTH - 24),
      y: Math.min(selectedNode.y + 40, CANVAS_HEIGHT - NODE_HEIGHT - 24),
      title: `${selectedNode.title} Copy`,
      config: { ...selectedNode.config },
    };
    setNodes((prev) => [...prev, duplicate]);
    setSelectedNodeId(duplicate.id);
    setSelectedEdgeId(null);
  };

  const deleteSelectedEdge = () => {
    if (!selectedEdge) return;
    setEdges((prev) => prev.filter((edge) => edge.id !== selectedEdge.id));
    setSelectedEdgeId(null);
  };

  const createEdge = (from: string, to: string) => {
    if (from === to) return;
    const exists = edges.some((edge) => edge.from === from && edge.to === to);
    if (exists) return;
    const id = `edge-${crypto.randomUUID()}`;
    setEdges((prev) => [...prev, { id, from, to, label: "flow" }]);
    setSelectedNodeId(null);
    setSelectedEdgeId(id);
  };

  const handleNodeClick = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  };

  const handleOutputPortClick = (event: React.MouseEvent, nodeId: string) => {
    event.stopPropagation();
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setConnectingFrom((prev) => (prev === nodeId ? null : nodeId));
  };

  const handleInputPortClick = (event: React.MouseEvent, nodeId: string) => {
    event.stopPropagation();
    if (connectingFrom && connectingFrom !== nodeId) {
      createEdge(connectingFrom, nodeId);
      setConnectingFrom(null);
      return;
    }
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  };

  const handleEdgeClick = (edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    setConnectingFrom(null);
  };

  const beginDrag = (event: React.MouseEvent<HTMLDivElement>, node: BuilderNode) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setDrag({
      nodeId: node.id,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    });
  };

  const clearSelection = () => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setConnectingFrom(null);
  };

  const nodeMap = useMemo(
    () => Object.fromEntries(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  return (
    <div className="ag-builder-shell">
      <aside className="ag-builder-sidebar">
        <div className="ag-builder-sidebar-head">
          <div className="ag-builder-eyebrow">Palette</div>
          <div className="ag-builder-title">Agent Builder</div>
          <div className="ag-builder-copy">
            Build an agent graph from zero, wire branches by hand, and edit every step directly in the inspector.
          </div>
        </div>

        <div className="ag-builder-stat-grid">
          <div className="ag-builder-stat">
            <span>{stats.nodes}</span>
            Nodes
          </div>
          <div className="ag-builder-stat">
            <span>{stats.connectors}</span>
            Connectors
          </div>
          <div className="ag-builder-stat">
            <span>{stats.specialists}</span>
            Workers
          </div>
        </div>

        <div className="ag-builder-palette">
          {(["trigger", "router", "memory", "specialist", "tools", "approval", "output"] as BuilderNodeType[]).map((type) => (
            <button key={type} className="ag-builder-palette-item" onClick={() => addNode(type)}>
              <span className="ag-builder-palette-dot" style={{ background: NODE_PRESETS[type].accent }} />
              <span>
                <strong>{NODE_PRESETS[type].title}</strong>
                <small>{NODE_PRESETS[type].subtitle}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="ag-builder-sidebar-foot">
          <button className="ag-builder-action ag-builder-secondary" onClick={clearCanvas}>
            Clear Canvas
          </button>
        </div>
      </aside>

      <section className="ag-builder-main">
        <div className="ag-builder-toolbar">
          <div>
            <div className="ag-builder-eyebrow">Canvas</div>
            <div className="ag-builder-title">Interactive Agent Graph</div>
          </div>
          <div className="ag-builder-toolbar-badges">
            <span>{connectingFrom ? "click an input port to connect" : "drag nodes to arrange"}</span>
            <span>{selectedEdge ? "connector selected" : selectedNode ? "node selected" : "blank selection"}</span>
          </div>
        </div>

        <div className="ag-builder-canvas" ref={canvasRef} onClick={clearSelection}>
          <div className="ag-builder-canvas-stage" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}>
            <svg className="ag-builder-lines" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} preserveAspectRatio="none">
              {edges.map((edge) => {
                const from = nodeMap[edge.from];
                const to = nodeMap[edge.to];
                if (!from || !to) return null;
                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + NODE_HEIGHT / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_HEIGHT / 2;
                const c1 = x1 + 92;
                const c2 = x2 - 92;
                const selected = selectedEdgeId === edge.id;
                return (
                  <g key={edge.id}>
                    <path
                      d={`M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`}
                      className={`ag-builder-line${selected ? " selected" : ""}`}
                    />
                    <path
                      d={`M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`}
                      className="ag-builder-line-hit"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleEdgeClick(edge.id);
                      }}
                    />
                    <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 12} className="ag-builder-line-label">
                      {edge.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {nodes.length === 0 && (
              <div className="ag-builder-empty-canvas">
                <div className="ag-builder-empty-title">Start with a blank graph</div>
                <div className="ag-builder-empty-copy">
                  Add nodes from the palette, drag them into place, then wire each connector yourself. Nothing is prebuilt.
                </div>
                <div className="ag-builder-empty-actions">
                  <button className="ag-builder-action ag-builder-primary" onClick={() => addNode("trigger")}>
                    Add Trigger
                  </button>
                  <button className="ag-builder-action ag-builder-secondary" onClick={() => addNode("specialist")}>
                    Add Specialist
                  </button>
                </div>
              </div>
            )}

            {nodes.map((node) => (
              <div
                key={node.id}
                role="button"
                tabIndex={0}
                className={`ag-builder-node ${selectedNodeId === node.id ? "selected" : ""} ${connectingFrom === node.id ? "connecting" : ""}`}
                style={{ left: node.x, top: node.y, "--node-accent": node.accent } as React.CSSProperties}
                onMouseDown={(event) => beginDrag(event, node)}
                onClick={(event) => {
                  event.stopPropagation();
                  handleNodeClick(node.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleNodeClick(node.id);
                  }
                }}
              >
                <button
                  type="button"
                  className="ag-builder-port in"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => handleInputPortClick(event, node.id)}
                  aria-label={`Connect into ${node.title}`}
                />
                <button
                  type="button"
                  className="ag-builder-port out"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => handleOutputPortClick(event, node.id)}
                  aria-label={`Connect from ${node.title}`}
                />
                <div className="ag-builder-node-eyebrow">{node.type}</div>
                <div className="ag-builder-node-title">{node.title}</div>
                <div className="ag-builder-node-subtitle">{node.subtitle}</div>
                <div className="ag-builder-node-chip">{node.config.connector}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <aside className="ag-builder-inspector">
        <div className="ag-builder-eyebrow">Inspector</div>
        <div className="ag-builder-title">
          {selectedNode?.title ?? selectedEdge?.label ?? "Nothing selected"}
        </div>

        {selectedNode && (
          <>
            <div className="ag-builder-inspector-actions">
              <button
                className="ag-builder-action ag-builder-secondary"
                onClick={() => setConnectingFrom((prev) => (prev === selectedNode.id ? null : selectedNode.id))}
              >
                {connectingFrom === selectedNode.id ? "Cancel Connect" : "Connect From Here"}
              </button>
              <button className="ag-builder-action ag-builder-secondary" onClick={duplicateSelectedNode}>
                Duplicate Node
              </button>
              <button className="ag-builder-action ag-builder-danger" onClick={deleteSelectedNode}>
                Delete Node
              </button>
            </div>

            <label className="ag-builder-field">
              Label
              <input
                value={selectedNode.title}
                onChange={(e) => updateSelectedNode((node) => ({ ...node, title: e.target.value }))}
              />
            </label>

            <label className="ag-builder-field">
              Summary
              <input
                value={selectedNode.subtitle}
                onChange={(e) => updateSelectedNode((node) => ({ ...node, subtitle: e.target.value }))}
              />
            </label>

            {selectedNode.type === "specialist" ? (
              <label className="ag-builder-field">
                Specialist Connector
                <select
                  value={selectedNode.config.connector}
                  onChange={(e) => updateSelectedNode((node) => ({
                    ...node,
                    title: specialistOptions.find((option) => option.id === e.target.value)?.name ?? node.title,
                    config: { ...node.config, connector: e.target.value },
                  }))}
                >
                  {specialistOptions.map((specialist) => (
                    <option key={specialist.id} value={specialist.id}>
                      {specialist.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="ag-builder-field">
                Connector Name
                <input
                  value={selectedNode.config.connector}
                  onChange={(e) => updateSelectedNode((node) => ({
                    ...node,
                    config: { ...node.config, connector: e.target.value },
                  }))}
                />
              </label>
            )}

            <label className="ag-builder-field">
              Prompt / Instruction
              <textarea
                value={selectedNode.config.prompt}
                onChange={(e) => updateSelectedNode((node) => ({
                  ...node,
                  config: { ...node.config, prompt: e.target.value },
                }))}
                rows={5}
              />
            </label>

            <div className="ag-builder-field-grid">
              <label className="ag-builder-field">
                Timeout (sec)
                <input
                  type="number"
                  min={0}
                  value={selectedNode.config.timeoutSec}
                  onChange={(e) => updateSelectedNode((node) => ({
                    ...node,
                    config: { ...node.config, timeoutSec: Number(e.target.value) || 0 },
                  }))}
                />
              </label>
              <label className="ag-builder-field">
                Retries
                <input
                  type="number"
                  min={0}
                  value={selectedNode.config.retries}
                  onChange={(e) => updateSelectedNode((node) => ({
                    ...node,
                    config: { ...node.config, retries: Number(e.target.value) || 0 },
                  }))}
                />
              </label>
            </div>

            <div className="ag-builder-field-grid">
              <label className="ag-builder-field">
                Position X
                <input
                  type="number"
                  value={Math.round(selectedNode.x)}
                  onChange={(e) => updateSelectedNode((node) => ({
                    ...node,
                    x: Math.max(24, Math.min(CANVAS_WIDTH - NODE_WIDTH - 24, Number(e.target.value) || 24)),
                  }))}
                />
              </label>
              <label className="ag-builder-field">
                Position Y
                <input
                  type="number"
                  value={Math.round(selectedNode.y)}
                  onChange={(e) => updateSelectedNode((node) => ({
                    ...node,
                    y: Math.max(24, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 24, Number(e.target.value) || 24)),
                  }))}
                />
              </label>
            </div>

            <label className="ag-builder-field">
              Notes
              <textarea
                value={selectedNode.config.notes}
                onChange={(e) => updateSelectedNode((node) => ({
                  ...node,
                  config: { ...node.config, notes: e.target.value },
                }))}
                rows={6}
              />
            </label>

            {selectedSpecialistMeta && (
              <div className="ag-builder-detail-card">
                <strong>{selectedSpecialistMeta.name}</strong>
                <p>{selectedSpecialistMeta.description}</p>
                <span>Auth {selectedSpecialistMeta.authority_level} · {selectedSpecialistMeta.tools.length} tools</span>
              </div>
            )}
          </>
        )}

        {!selectedNode && selectedEdge && (
          <>
            <div className="ag-builder-inspector-actions">
              <button className="ag-builder-action ag-builder-danger" onClick={deleteSelectedEdge}>
                Delete Connector
              </button>
            </div>

            <label className="ag-builder-field">
              Connector Label
              <input
                value={selectedEdge.label}
                onChange={(e) => updateSelectedEdge((edge) => ({ ...edge, label: e.target.value }))}
              />
            </label>

            <label className="ag-builder-field">
              From Node
              <select
                value={selectedEdge.from}
                onChange={(e) => {
                  const newFrom = e.target.value;
                  if (newFrom === selectedEdge.to) return;
                  if (edges.some((ed) => ed.id !== selectedEdge.id && ed.from === newFrom && ed.to === selectedEdge.to)) return;
                  updateSelectedEdge((edge) => ({ ...edge, from: newFrom }));
                }}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={node.id === selectedEdge.to}>
                    {node.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="ag-builder-field">
              To Node
              <select
                value={selectedEdge.to}
                onChange={(e) => {
                  const newTo = e.target.value;
                  if (newTo === selectedEdge.from) return;
                  if (edges.some((ed) => ed.id !== selectedEdge.id && ed.from === selectedEdge.from && ed.to === newTo)) return;
                  updateSelectedEdge((edge) => ({ ...edge, to: newTo }));
                }}
              >
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={node.id === selectedEdge.from}>
                    {node.title}
                  </option>
                ))}
              </select>
            </label>

            <div className="ag-builder-detail-card">
              <strong>Connector Editing</strong>
              <p>Select a connector line on the canvas to rename it, re-target it, or remove it entirely.</p>
              <span>Edges: {edges.length} active</span>
            </div>
          </>
        )}

        {!selectedNode && !selectedEdge && (
          <div className="ag-builder-empty">
            Select a node or connector to edit it. You can drag nodes, duplicate them, create links, rename links, and delete either side directly from this panel.
          </div>
        )}
      </aside>
    </div>
  );
}
