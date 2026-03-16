import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  type Connection,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useApiData, api } from "../../hooks/useApi";
import type { WorkflowEvent } from "../../hooks/useWebSocket";
import WorkflowNodeComponent from "./WorkflowNode";
import NodePalette from "./NodePalette";
import NodeProperties from "./NodeProperties";
import ExecutionMonitor from "./ExecutionMonitor";
import VersionHistory from "./VersionHistory";
import NLChatSidebar from "./NLChatSidebar";

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

type WorkflowVersion = {
  id: string;
  workflow_id: string;
  version: number;
  definition: {
    nodes: Array<{
      id: string;
      type: string;
      label: string;
      position: { x: number; y: number };
      config: Record<string, unknown>;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      label?: string;
    }>;
    settings: Record<string, unknown>;
  };
  changelog: string | null;
  created_at: number;
};

const nodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent,
};

export default function WorkflowCanvas({
  workflowId,
  workflowEvents,
  sendMessage,
}: {
  workflowId: string;
  workflowEvents: WorkflowEvent[];
  sendMessage: (text: string) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"properties" | "executions" | "versions" | "chat">("properties");
  const [showPalette, setShowPalette] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: nodeCatalog } = useApiData<NodeCatalogItem[]>("/api/workflows/nodes");
  const { data: latestVersion, refetch: refetchVersion } = useApiData<WorkflowVersion[]>(
    `/api/workflows/${workflowId}/versions`
  );

  const catalogMap = useMemo(() => {
    const map = new Map<string, NodeCatalogItem>();
    nodeCatalog?.forEach(n => map.set(n.type, n));
    return map;
  }, [nodeCatalog]);

  // Load workflow definition from latest version
  useEffect(() => {
    if (!latestVersion || latestVersion.length === 0) return;
    const version = latestVersion[0]!;
    const def = version.definition;

    const flowNodes: Node[] = def.nodes.map(n => {
      const catalogItem = catalogMap.get(n.type);
      return {
        id: n.id,
        type: "workflowNode",
        position: n.position,
        data: {
          label: n.label,
          nodeType: n.type,
          icon: catalogItem?.icon ?? "?",
          color: catalogItem?.color ?? "#666",
          config: n.config,
          configSchema: catalogItem?.configSchema ?? {},
          inputs: catalogItem?.inputs ?? ["default"],
          outputs: catalogItem?.outputs ?? ["default"],
        },
      };
    });

    const flowEdges: Edge[] = def.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      label: e.label,
      style: { stroke: "rgba(255,255,255,0.15)", strokeWidth: 1.5 },
      animated: false,
    }));

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [latestVersion, catalogMap]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges(eds => addEdge({
      ...connection,
      id: `e-${Date.now()}`,
      style: { stroke: "rgba(255,255,255,0.15)", strokeWidth: 1.5 },
    }, eds));
    scheduleSave();
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData("nodeType");
    if (!nodeType || !catalogMap.has(nodeType)) return;

    const catalogItem = catalogMap.get(nodeType)!;
    const bounds = reactFlowWrapper.current?.getBoundingClientRect();
    if (!bounds) return;

    const newNode: Node = {
      id: `node-${Date.now()}`,
      type: "workflowNode",
      position: {
        x: event.clientX - bounds.left - 90,
        y: event.clientY - bounds.top - 20,
      },
      data: {
        label: catalogItem.label,
        nodeType: catalogItem.type,
        icon: catalogItem.icon,
        color: catalogItem.color,
        config: {},
        configSchema: catalogItem.configSchema,
        inputs: catalogItem.inputs,
        outputs: catalogItem.outputs,
      },
    };

    setNodes(nds => [...nds, newNode]);
    setSelectedNodeId(newNode.id);
    scheduleSave();
  }, [catalogMap]);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const definition = {
          nodes: nodes.map(n => ({
            id: n.id,
            type: n.data.nodeType,
            label: n.data.label,
            position: n.position,
            config: n.data.config ?? {},
          })),
          edges: edges.map(e => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            label: e.label,
          })),
          settings: latestVersion?.[0]?.definition.settings ?? {
            maxRetries: 3, retryDelayMs: 5000, timeoutMs: 300000,
            parallelism: "parallel", onError: "stop",
          },
        };
        await api(`/api/workflows/${workflowId}/versions`, {
          method: "POST",
          body: JSON.stringify({ definition, changelog: "Auto-save" }),
        });
      } catch (err) {
        console.error("Failed to save workflow:", err);
      }
    }, 2000);
  }, [nodes, edges, workflowId, latestVersion]);

  const handleConfigUpdate = useCallback((nodeId: string, config: Record<string, unknown>) => {
    setNodes(nds => nds.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, config } } : n
    ));
    scheduleSave();
  }, [scheduleSave]);

  // Animate running nodes based on WS events
  useEffect(() => {
    const runningNodes = new Set<string>();
    for (const evt of workflowEvents) {
      if (evt.workflowId !== workflowId) continue;
      if (evt.type === "step_started" && evt.nodeId) runningNodes.add(evt.nodeId);
      if ((evt.type === "step_completed" || evt.type === "step_failed") && evt.nodeId) runningNodes.delete(evt.nodeId);
    }
    setEdges(eds => eds.map(e => ({
      ...e,
      animated: runningNodes.has(e.source),
    })));
  }, [workflowEvents, workflowId]);

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const tabLabels = { properties: "Config", executions: "Runs", versions: "Versions", chat: "AI" } as const;

  return (
    <div className="wf-canvas-layout">
      {/* Left: Node Palette */}
      {showPalette ? (
        <NodePalette catalog={nodeCatalog ?? []} onCollapse={() => setShowPalette(false)} />
      ) : (
        <div className="wf-palette-collapsed">
          <button className="wf-palette-expand" onClick={() => setShowPalette(true)} title="Show node palette">
            &#9654;
          </button>
        </div>
      )}

      {/* Center: Canvas */}
      <div ref={reactFlowWrapper} className="wf-canvas-center">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={(changes) => { onNodesChange(changes); scheduleSave(); }}
          onEdgesChange={(changes) => { onEdgesChange(changes); scheduleSave(); }}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          style={{ background: "var(--surface-1)" }}
        >
          <Controls />
          <MiniMap
            nodeColor="rgba(139,92,246,0.6)"
            maskColor="rgba(0,0,0,0.5)"
          />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.04)" />
        </ReactFlow>
      </div>

      {/* Right: Tabbed Panel */}
      {showPanel ? (
        <div className="wf-right-panel">
          <div className="wf-panel-tabs">
            {(["properties", "executions", "versions", "chat"] as const).map(tab => (
              <button
                key={tab}
                className={`wf-panel-tab${rightTab === tab ? " active" : ""}`}
                onClick={() => setRightTab(tab)}
              >
                {tabLabels[tab]}
              </button>
            ))}
            <button
              className="wf-panel-collapse"
              onClick={() => setShowPanel(false)}
              title="Collapse panel"
            >
              &#9654;
            </button>
          </div>

          <div className="wf-panel-body">
            {rightTab === "properties" && (
              selectedNode ? (
                <NodeProperties
                  node={selectedNode}
                  onConfigUpdate={(config) => handleConfigUpdate(selectedNode.id, config)}
                />
              ) : (
                <div className="wf-panel-placeholder">
                  Select a node to configure it, or drag one from the palette.
                </div>
              )
            )}
            {rightTab === "executions" && (
              <ExecutionMonitor workflowId={workflowId} workflowEvents={workflowEvents} />
            )}
            {rightTab === "versions" && (
              <VersionHistory workflowId={workflowId} />
            )}
            {rightTab === "chat" && (
              <NLChatSidebar workflowId={workflowId} onDefinitionUpdate={refetchVersion} />
            )}
          </div>
        </div>
      ) : (
        <div className="wf-panel-collapsed">
          <button className="wf-palette-expand" onClick={() => setShowPanel(true)} title="Show panel">
            &#9664;
          </button>
        </div>
      )}
    </div>
  );
}
