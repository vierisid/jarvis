import React, { useEffect, useId, useRef, useState } from "react";
import { Check, GitBranch, Link2, Plus, Search, X } from "lucide-react";
import { FloatingSurface } from "../../components/controls/Floating";
import { useBriefReducedMotion } from "../../motion";
import { ingredientKey, sameIngredients, type IngredientCatalog, type SelectedIngredient } from "./model";
import "./picker.css";

export function IngredientChips({ selected, onChange }: {selected: readonly SelectedIngredient[]; onChange: (items: SelectedIngredient[]) => void}) {
  return <div className="brief-ingredient-chips" aria-label="Selected workflow ingredients">
    {selected.map((item,index) => <span className="brief-ingredient-chip" data-kind={item.selection.kind} key={ingredientKey(item.selection)}>
      {item.selection.kind === "connection" ? <Link2 size={14} aria-hidden="true"/> : <GitBranch size={14} aria-hidden="true"/>}
      <span>{item.displayName}</span>
      <button type="button" aria-label={`Remove ${item.displayName}`} onClick={event => {
        const container = event.currentTarget.closest(".brief-composer-surface");
        onChange(selected.filter((_,i) => i !== index));
        requestAnimationFrame(() => {
          const buttons = container?.querySelectorAll<HTMLButtonElement>(".brief-ingredient-chip button");
          (buttons?.[Math.min(index,buttons.length-1)] ?? container?.querySelector<HTMLTextAreaElement>("textarea"))?.focus({preventScroll:true});
        });
      }}><X size={12} aria-hidden="true"/></button>
    </span>)}
  </div>;
}

/** Non-modal, scoped menu. State survives closing; changing account remounts its owner. */
export function IngredientPicker({ catalog, selected, onChange, enabled, reducedMotion }: {
  catalog: IngredientCatalog; selected: readonly SelectedIngredient[]; onChange: (items: SelectedIngredient[]) => void;
  enabled: boolean; reducedMotion?: boolean;
}) {
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement|null>(null);
  const reduced = useBriefReducedMotion(reducedMotion);
  const [open,setOpen] = useState(false), [present,setPresent] = useState(false);
  const [tab,setTab] = useState<"connection"|"library-action">("connection"), [query,setQuery] = useState(""), [group,setGroup] = useState("");
  const [feedback,setFeedback] = useState("");
  const active = open && enabled;
  function close(restore = false) { setOpen(false); if (restore) anchor.current?.focus({preventScroll:true}); }
  useEffect(() => {
    if (active) { setPresent(true); return; }
    const timer = setTimeout(() => setPresent(false), reduced ? 0 : 180);
    return () => clearTimeout(timer);
  }, [active,reduced]);
  useEffect(() => { if (!enabled) setOpen(false); },[enabled]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    document.addEventListener("pointerdown",outside); document.addEventListener("focusin",outside);
    document.addEventListener("keydown",escape,true);
    return () => { document.removeEventListener("pointerdown",outside); document.removeEventListener("focusin",outside); document.removeEventListener("keydown",escape,true); };
  },[active]);
  useEffect(() => {
    if (active && present) panel.current?.querySelector<HTMLInputElement>("input")?.focus({preventScroll:true});
  },[active,present]);
  const ready = enabled && catalog.state === "ready";
  const groups = [...new Map(catalog.choices.filter(c => c.tab === "library-action").map(c => [c.groupId,c.group])).entries()]
    .sort((a,b)=>a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  // Metadata can rename a service or disappear independently of F-08 discovery.
  // Only a complete ready snapshot may clear a genuinely removed package.
  const missingGroup = catalog.state === "ready" && !!group && !groups.some(([id])=>id===group);
  const activeGroup = missingGroup ? "" : group;
  useEffect(() => {
    if (missingGroup) { setGroup(""); setFeedback("Selected service is no longer available. All services shown."); }
  },[missingGroup]);
  const rows = catalog.choices.filter(c => c.tab === tab && (tab === "connection" || !activeGroup || c.groupId === activeGroup)
    && `${c.displayName} ${c.group}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <button ref={anchor} type="button" className="brief-ingredient-trigger" aria-label="Add connection or library node"
      aria-haspopup="dialog" aria-expanded={active} aria-controls={active ? id : undefined} aria-disabled={!enabled}
      onClick={() => { if (enabled) { setPresent(true); setOpen(!open); } }}>
      <Plus size={18} aria-hidden="true" style={{transform:active ? "rotate(45deg)" : "rotate(0deg)"}}/>
    </button>
    {present && <FloatingSurface anchor={anchor} kind="menu" placement="bottom-start" className="brief-ingredient-floating"
      onReady={element => { panel.current=element; }}>
      <div id={id} role="dialog" aria-label="Choose workflow ingredients" aria-hidden={!active} inert={!active}
        className="brief-ingredient-picker" data-open={active} data-reduced={reduced}
        onKeyDown={event => {
          // Portaled dialog exits back into the invoking composer's tab order.
          if (event.key !== "Tab") return;
          const focusable = [...panel.current?.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), input, select') ?? []];
          if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); close(true); }
          else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
            event.preventDefault(); close(); anchor.current?.closest(".brief-composer-surface")?.querySelector<HTMLTextAreaElement>("textarea")?.focus({preventScroll:true});
          }
        }}>
        <div className="brief-ingredient-tabs" role="tablist" aria-label="Ingredient source">
          {(["connection","library-action"] as const).map((value,i) => <button type="button" role="tab" id={`${id}-tab-${i}`}
            key={value} aria-selected={tab===value} aria-controls={`${id}-results`} tabIndex={tab===value?0:-1}
            onClick={() => {setTab(value);setFeedback("");}}
            onKeyDown={event => {
              if (["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) {
                event.preventDefault(); const next = event.key === "Home" ? "connection" : event.key === "End" ? "library-action" : tab === "connection" ? "library-action" : "connection";
                setTab(next); panel.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(id)}-tab-${next === "connection" ? 0 : 1}`)?.focus();
              }
            }}>{i===0?"Connections":"Library"}</button>)}
        </div>
        <div className="brief-ingredient-search"><Search size={16} aria-hidden="true"/><input aria-label="Search ingredients" type="search" placeholder="Search connections or library"
          value={query} maxLength={128} onChange={e=>setQuery(e.target.value)}/></div>
        <label className="brief-ingredient-category" style={{visibility:tab==="library-action"?"visible":"hidden"}}>Service
          <select aria-label="Library service" value={activeGroup} tabIndex={tab==="library-action"?0:-1} onChange={e=>setGroup(e.target.value)}>
            <option value="">All services</option>{groups.map(([id,name])=><option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <div id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-tab-${tab==="connection"?0:1}`} className="brief-ingredient-results">
          {!ready ? <div className="brief-ingredient-empty" role="status">{catalog.state==="loading"?"Loading ingredients…":"Ingredients are unavailable. Your selection is kept."}
            {catalog.refresh && catalog.state!=="loading" && <button type="button" onClick={catalog.refresh}>Try again</button>}</div>
            : !rows.length ? <p className="brief-ingredient-empty">{query || (tab==="library-action" && activeGroup) ? "No matching ingredients. Try another search or service." : tab==="connection" ? "No available connections. Connect an account in Connected workspace." : "No library nodes are available."}</p>
            : rows.map(row => {
              const selectedIndex = selected.findIndex(s => ingredientKey(s.selection) === row.key);
              const checked = selectedIndex !== -1;
              const changed = checked && row.selection && !sameIngredients([selected[selectedIndex]!.selection],[row.selection]);
              const disabled = row.status!=="ready" || !row.selection || (!checked && selected.length>=64);
              return <button type="button" role="checkbox" className="brief-ingredient-row" key={row.key} aria-checked={checked} aria-disabled={disabled}
                onClick={() => {
                  if (disabled || !row.selection) return;
                  onChange(checked ? selected.filter((_,i)=>i!==selectedIndex) : [...selected,{selection:row.selection,displayName:row.displayName}]);
                  setFeedback(checked ? `${row.displayName} removed` : `${row.displayName} added`);
                }}>
                {row.tab==="connection"?<Link2 size={16} aria-hidden="true"/>:<GitBranch size={16} aria-hidden="true"/>}
                <span><strong>{row.displayName}</strong><small>{changed?"Version changed · remove and select again":row.status==="uninstalled"?"Not installed":row.status==="missing-account"?"Account connection required":row.status==="unavailable"?"Unavailable":row.tab==="connection"?"Connected account":"Library node"}</small></span>
                {checked && <Check size={16} aria-hidden="true"/>}
              </button>;
            })}
        </div>
        <div className="brief-ingredient-footer"><span>{selected.length} {selected.length===1?"ingredient":"ingredients"} selected{selected.length===64?" · limit reached":""}</span>
          <button type="button" onClick={()=>close(true)}>Done</button></div>
        <span className="brief-sr-only" role="status">{feedback}</span>
      </div>
    </FloatingSurface>}
  </>;
}
