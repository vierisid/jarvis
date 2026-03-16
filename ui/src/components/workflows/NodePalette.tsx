import React, { useState } from "react";

type NodeCatalogItem = {
  type: string;
  label: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  configSchema: Record<string, unknown>;
  inputs: string[];
  outputs: string[];
};

const CATEGORY_ORDER = ["trigger", "action", "logic", "transform", "error"];
const CATEGORY_LABELS: Record<string, string> = {
  trigger: "Triggers",
  action: "Actions",
  logic: "Logic",
  transform: "Transform",
  error: "Error Handling",
};

export default function NodePalette({ catalog, onCollapse }: { catalog: NodeCatalogItem[]; onCollapse?: () => void }) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = search
    ? catalog.filter(n =>
        n.label.toLowerCase().includes(search.toLowerCase()) ||
        n.type.toLowerCase().includes(search.toLowerCase()) ||
        n.description.toLowerCase().includes(search.toLowerCase())
      )
    : catalog;

  const grouped = new Map<string, NodeCatalogItem[]>();
  for (const cat of CATEGORY_ORDER) {
    const items = filtered.filter(n => n.category === cat);
    if (items.length > 0) grouped.set(cat, items);
  }

  const toggleCategory = (cat: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const onDragStart = (e: React.DragEvent, nodeType: string) => {
    e.dataTransfer.setData("nodeType", nodeType);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="wf-palette">
      <div className="wf-palette-header">
        <span className="wf-palette-label">Nodes</span>
        {onCollapse && (
          <button className="wf-palette-collapse" onClick={onCollapse} title="Collapse palette">
            &#9664;
          </button>
        )}
      </div>

      <input
        type="text"
        className="wf-palette-search"
        placeholder="Search nodes..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      <div className="wf-palette-scroll">
        {Array.from(grouped.entries()).map(([cat, items]) => (
          <div key={cat}>
            <div
              className="wf-palette-category"
              onClick={() => toggleCategory(cat)}
            >
              <span>{CATEGORY_LABELS[cat] ?? cat}</span>
              <span style={{ fontSize: "8px" }}>{collapsed.has(cat) ? "\u25B6" : "\u25BC"}</span>
            </div>

            {!collapsed.has(cat) && items.map(node => (
              <div
                key={node.type}
                className="wf-palette-node"
                draggable
                onDragStart={e => onDragStart(e, node.type)}
                title={node.description}
              >
                <div className="wf-palette-node-icon" style={{ background: node.color }}>
                  {node.icon}
                </div>
                <div className="wf-palette-node-name">{node.label}</div>
              </div>
            ))}
          </div>
        ))}

        {grouped.size === 0 && (
          <div className="wf-palette-empty">
            {search ? "No nodes match" : "Loading nodes..."}
          </div>
        )}
      </div>
    </div>
  );
}
