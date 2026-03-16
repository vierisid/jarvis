import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import type { Goal } from "../../pages/GoalsPage";

type Props = {
  goals: Goal[];
  onSelect: (goal: Goal) => void;
  selectedGoalId?: string;
};

type PositionedNode = {
  goal: Goal;
  x: number;
  y: number;
  parentGoal?: Goal;
};

type LevelConfig = { size: number; color: string; className: string };

const LEVEL_CONFIG_MAP: Record<string, LevelConfig> = {
  objective:    { size: 82, color: "#8B5CF6", className: "goals-node-obj" },
  key_result:   { size: 56, color: "#60A5FA", className: "goals-node-kr" },
  milestone:    { size: 42, color: "#34D399", className: "goals-node-ms" },
  task:         { size: 30, color: "#FBBF24", className: "goals-node-task" },
  daily_action: { size: 24, color: "#22D3EE", className: "goals-node-daily" },
};

const LEVEL_CONFIG_FALLBACK: LevelConfig = { size: 30, color: "#FBBF24", className: "goals-node-task" };

function getLevelConfig(level: string): LevelConfig {
  return LEVEL_CONFIG_MAP[level] ?? LEVEL_CONFIG_FALLBACK;
}

const HEALTH_COLORS: Record<string, string> = {
  on_track: "var(--emerald)",
  at_risk:  "var(--amber)",
  behind:   "var(--orange)",
  critical: "var(--rose)",
};

/**
 * Score arc ring rendered as an SVG circle with a stroke-dasharray
 * representing the current score (0.0–1.0).
 */
function ScoreArc({ size, score, color }: { size: number; score: number; color: string }) {
  const r = (size / 2) - 5;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ position: "absolute", top: 0, left: 0, transform: "rotate(-90deg)" }}
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={`${color}20`}
        strokeWidth={size > 60 ? 3 : 2.5}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={size > 60 ? 3 : 2.5}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Build a map of goal id → child goals for fast tree traversal.
 */
function buildChildMap(goals: Goal[]): Map<string | null, Goal[]> {
  const map = new Map<string | null, Goal[]>();
  for (const g of goals) {
    const key = g.parent_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(g);
  }
  return map;
}

/**
 * Compute pixel positions for every goal using a radial tree layout.
 * Objectives are placed in a vertical stack starting at ~20% from the left.
 * Children radiate outward from their parent in a fan/arc pattern.
 */
function computePositions(
  goals: Goal[],
  canvasW: number,
  canvasH: number
): PositionedNode[] {
  if (goals.length === 0) return [];

  const childMap = buildChildMap(goals);

  // Distance from parent to child per level transition
  // Scale down when there are many goals to keep within bounds
  const density = Math.min(1, 14 / Math.max(goals.length, 1));
  const scale = 0.6 + 0.4 * density;
  const DISTANCES: Record<string, number> = {
    objective:    0,
    key_result:   Math.round(160 * scale),
    milestone:    Math.round(125 * scale),
    task:         Math.round(105 * scale),
    daily_action: Math.round(85 * scale),
  };

  const result: PositionedNode[] = [];

  // Separate true objectives from orphaned non-objectives
  const rootGoals = childMap.get(null) ?? [];
  const objectives = rootGoals.filter((g) => g.level === "objective");
  const orphans = rootGoals.filter((g) => g.level !== "objective");

  // Vertical spacing — clamp so nodes stay within canvas with padding
  const OBJ_X = canvasW * 0.20;
  const PADDING_TOP = 160;
  const PADDING_BOT = 80;
  const usableH = canvasH - PADDING_TOP - PADDING_BOT;
  const OBJ_STEP_Y = Math.min(220, usableH / Math.max(objectives.length, 1));
  const totalObjHeight = (objectives.length - 1) * OBJ_STEP_Y;
  const OBJ_START_Y = PADDING_TOP + (usableH - totalObjHeight) / 2;

  /**
   * Recursively place a node and its children.
   */
  function placeNode(
    goal: Goal,
    x: number,
    y: number,
    parentGoal: Goal | undefined,
    angleStart: number,
    angleEnd: number
  ) {
    result.push({ goal, x, y, parentGoal });

    const children = childMap.get(goal.id) ?? [];
    if (children.length === 0) return;

    const firstChild = children[0];
    if (!firstChild) return;
    const childLevel = firstChild.level;
    const distance = DISTANCES[childLevel] ?? 130;
    const angleRange = angleEnd - angleStart;
    const step = children.length > 1 ? angleRange / (children.length - 1) : 0;

    children.forEach((child, idx) => {
      const angle = children.length === 1
        ? (angleStart + angleEnd) / 2
        : angleStart + idx * step;

      const cx = x + distance * Math.cos(angle);
      const cy = y + distance * Math.sin(angle);

      // Narrow the arc for grandchildren so they cluster tightly
      const childArcHalf = (angleRange * 0.45) / Math.max(children.length, 1);
      placeNode(child, cx, cy, goal, angle - childArcHalf, angle + childArcHalf);
    });
  }

  objectives.forEach((obj, i) => {
    const ox = OBJ_X;
    const oy = OBJ_START_Y + i * OBJ_STEP_Y;
    placeNode(obj, ox, oy, undefined, -Math.PI * 0.30, Math.PI * 0.30);
  });

  // Place orphaned non-objective goals in a loose cluster at right side
  const orphanStartX = canvasW * 0.70;
  const orphanStartY = Math.max(80, (canvasH - orphans.length * 90) / 2 + 45);
  const orphanStepY = Math.min(90, (canvasH - 80) / Math.max(orphans.length, 1));

  orphans.forEach((g, i) => {
    const ox = orphanStartX + (i % 2 === 0 ? 0 : 60);
    const oy = orphanStartY + i * orphanStepY;
    placeNode(g, ox, oy, undefined, -Math.PI * 0.3, Math.PI * 0.3);
  });

  // Place any truly orphaned goals (parent_id set but parent not found)
  const placedIds = new Set(result.map((n) => n.goal.id));
  goals.forEach((g) => {
    if (!placedIds.has(g.id)) {
      result.push({ goal: g, x: canvasW * 0.5, y: canvasH * 0.5 });
    }
  });

  // Post-layout bounds check — shift all nodes so nothing is clipped
  const PAD = 60;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of result) {
    const half = getLevelConfig(n.goal.level).size / 2;
    minX = Math.min(minX, n.x - half);
    minY = Math.min(minY, n.y - half);
    maxX = Math.max(maxX, n.x + half);
    maxY = Math.max(maxY, n.y + half);
  }
  const shiftX = minX < PAD ? PAD - minX : 0;
  const shiftY = minY < PAD ? PAD - minY : 0;
  const contentW = (maxX + shiftX) + PAD;
  const contentH = (maxY + shiftY) + PAD;
  const scaleX = contentW > canvasW ? canvasW / contentW : 1;
  const scaleY = contentH > canvasH ? canvasH / contentH : 1;
  const boundsScale = Math.min(scaleX, scaleY);

  if (shiftX !== 0 || shiftY !== 0 || boundsScale < 1) {
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    for (const n of result) {
      n.x = cx + ((n.x + shiftX) - cx) * boundsScale;
      n.y = cy + ((n.y + shiftY) - cy) * boundsScale;
    }
  }

  return result;
}

/** Connection stroke config per parent→child level pair */
type ConnectionStyle = { stroke: string; strokeWidth: number; dashArray: string };

function connectionStyle(parentLevel: string): ConnectionStyle {
  switch (parentLevel) {
    case "objective":
      return { stroke: "rgba(139,92,246,0.45)", strokeWidth: 1.5, dashArray: "6 4" };
    case "key_result":
      return { stroke: "rgba(96,165,250,0.35)", strokeWidth: 1.2, dashArray: "4 4" };
    case "milestone":
      return { stroke: "rgba(52,211,153,0.30)", strokeWidth: 1.0, dashArray: "3 4" };
    default:
      return { stroke: "rgba(255,255,255,0.18)", strokeWidth: 0.8, dashArray: "2 4" };
  }
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.15;

/**
 * GoalConstellation — radial tree visualisation of OKR goals.
 *
 * Supports pan (click-drag) and zoom (scroll wheel + buttons).
 */
export function GoalConstellation({ goals, onSelect, selectedGoalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1200, h: 700 });

  // Pan & zoom state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });

  // Measure container dimensions on mount and resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setCanvasSize({ w: width, h: height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo(
    () => computePositions(goals, canvasSize.w, canvasSize.h),
    [goals, canvasSize.w, canvasSize.h]
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.goal.id, n])), [nodes]);

  // --- Zoom handlers ---
  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
  }, []);

  const fitToView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // --- Pan handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only pan on middle-click or left-click on the canvas background
    const target = e.target as HTMLElement;
    const isBackground =
      target.classList.contains("goals-canvas-layer") ||
      target.classList.contains("goals-canvas-svg") ||
      target.tagName === "svg" ||
      target.tagName === "line";

    if (!isBackground && e.button === 0) return; // left-click on a node — don't pan

    e.preventDefault();
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    panOrigin.current = { ...pan };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({ x: panOrigin.current.x + dx, y: panOrigin.current.y + dy });
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  if (goals.length === 0) {
    return <div className="goals-canvas" ref={containerRef} />;
  }

  const transformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: "center center",
  };

  return (
    <div
      className="goals-canvas"
      ref={containerRef}
      role="region"
      aria-label="Goal constellation diagram"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      style={{ cursor: isPanning.current ? "grabbing" : "grab" }}
    >
      {/* Pannable + zoomable layer */}
      <div className="goals-canvas-layer" style={transformStyle}>
        {/* SVG connection lines — same coordinate space as nodes */}
        <svg
          className="goals-canvas-svg"
          width={canvasSize.w}
          height={canvasSize.h}
          viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          {nodes.map(({ goal, x, y, parentGoal }) => {
            if (!parentGoal) return null;
            const parentNode = nodeById.get(parentGoal.id);
            if (!parentNode) return null;
            const style = connectionStyle(parentGoal.level);
            return (
              <line
                key={`conn-${goal.id}`}
                x1={parentNode.x}
                y1={parentNode.y}
                x2={x}
                y2={y}
                stroke={style.stroke}
                strokeWidth={style.strokeWidth}
                strokeDasharray={style.dashArray}
                className="goals-dashScroll"
              />
            );
          })}
        </svg>

        {/* Goal nodes */}
        {nodes.map(({ goal, x, y }, i) => {
          const config = getLevelConfig(goal.level);
          const healthColor = HEALTH_COLORS[goal.health] ?? "var(--text-3)";
          const isSelected = goal.id === selectedGoalId;
          const scoreDisplay = goal.score.toFixed(2);
          const half = config.size / 2;

          return (
            <div
              key={goal.id}
              className={`goals-node ${config.className}${isSelected ? " selected" : ""}`}
              style={{
                left: x - half,
                top: y - half,
                animationDelay: `${i * 0.08}s`,
              }}
              onClick={(e) => { e.stopPropagation(); onSelect(goal); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(goal);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${goal.title}, score ${scoreDisplay}, ${goal.health}`}
              aria-pressed={isSelected}
            >
              {/* Circle body with gradient, glow, and arc */}
              <div
                className="goals-node-circle"
                style={{ width: config.size, height: config.size }}
              >
                <ScoreArc size={config.size} score={goal.score} color={config.color} />
                <span className="goals-node-score">{scoreDisplay}</span>
                <div
                  className="goals-node-health"
                  style={{ background: healthColor }}
                  aria-hidden="true"
                />
              </div>

              {/* Label rendered below node */}
              <span className="goals-node-label">{goal.title}</span>
            </div>
          );
        })}
      </div>

      {/* Legend — fixed position, not affected by pan/zoom */}
      <div className="goals-legend" aria-label="Node type legend">
        {[
          { label: "Objective",   color: "#8B5CF6", size: 12 },
          { label: "Key Result",  color: "#60A5FA", size: 10 },
          { label: "Milestone",   color: "#34D399", size: 8 },
          { label: "Task",        color: "#FBBF24", size: 6 },
          { label: "Daily",       color: "#22D3EE", size: 5 },
        ].map(({ label, color, size }) => (
          <div key={label} className="goals-legend-item">
            <div
              className="goals-legend-dot"
              style={{
                width: size + 4,
                height: size + 4,
                borderColor: color,
                background: `${color}1A`,
              }}
              aria-hidden="true"
            />
            <span className="goals-legend-label">{label}</span>
          </div>
        ))}
      </div>

      {/* Minimap — fixed position */}
      <div className="goals-minimap" aria-hidden="true">
        <svg width="84" height="56" viewBox="0 0 84 56">
          {nodes.map(({ goal, x, y }) => {
            const config = getLevelConfig(goal.level);
            const mx = (x / canvasSize.w) * 80 + 2;
            const my = (y / canvasSize.h) * 52 + 2;
            const r = Math.max(1.5, (config.size / 82) * 6);
            return (
              <circle
                key={goal.id}
                cx={mx}
                cy={my}
                r={r}
                fill={`${config.color}50`}
                stroke={`${config.color}AA`}
                strokeWidth="0.8"
              />
            );
          })}
          {nodes.map(({ goal, x, y, parentGoal }) => {
            if (!parentGoal) return null;
            const parentNode = nodeById.get(parentGoal.id);
            if (!parentNode) return null;
            const config = getLevelConfig(parentGoal.level);
            const mx1 = (parentNode.x / canvasSize.w) * 80 + 2;
            const my1 = (parentNode.y / canvasSize.h) * 52 + 2;
            const mx2 = (x / canvasSize.w) * 80 + 2;
            const my2 = (y / canvasSize.h) * 52 + 2;
            return (
              <line
                key={`ml-${goal.id}`}
                x1={mx1} y1={my1}
                x2={mx2} y2={my2}
                stroke={`${config.color}40`}
                strokeWidth="0.5"
                strokeDasharray="2 2"
              />
            );
          })}
          {/* Viewport indicator */}
          {zoom !== 1 || pan.x !== 0 || pan.y !== 0 ? (
            <rect
              x={Math.max(1, 2 + (-pan.x / zoom / canvasSize.w) * 80)}
              y={Math.max(1, 2 + (-pan.y / zoom / canvasSize.h) * 52)}
              width={Math.min(80, (80 / zoom))}
              height={Math.min(52, (52 / zoom))}
              fill="none"
              stroke="rgba(139,92,246,0.6)"
              strokeWidth="1"
              rx="1"
            />
          ) : null}
          <rect
            x="1" y="1" width="82" height="54"
            fill="none"
            stroke="rgba(139,92,246,0.35)"
            strokeWidth="0.8"
            rx="2"
          />
        </svg>
      </div>

      {/* Zoom controls — functional */}
      <div className="goals-zoom-controls" aria-label="Zoom controls">
        <button className="goals-zoom-btn" aria-label="Zoom in" title="Zoom in" onClick={zoomIn}>+</button>
        <button className="goals-zoom-btn" aria-label="Zoom out" title="Zoom out" onClick={zoomOut}>−</button>
        <button className="goals-zoom-btn goals-zoom-fit" aria-label="Fit to view" title="Fit to view" onClick={fitToView}>⊡</button>
      </div>
    </div>
  );
}
