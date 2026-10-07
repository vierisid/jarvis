import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { INGREDIENT_FIXTURES } from "./fixtures";
import type { IngredientCatalog, SelectedIngredient } from "./model";
let React:typeof import("react"), createRoot:typeof import("react-dom/client").createRoot, Picker:typeof import("./IngredientPicker").IngredientPicker, Chips:typeof import("./IngredientPicker").IngredientChips;
let host:HTMLDivElement,root:Root,selected:SelectedIngredient[],enabled:boolean,catalog:IngredientCatalog;
beforeAll(async()=>{GlobalRegistrator.register();(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;React=await import("react");({createRoot}=await import("react-dom/client"));({IngredientPicker:Picker,IngredientChips:Chips}=await import("./IngredientPicker"));});
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);selected=[];enabled=true;catalog={source:"fixture",scopeId:"a",state:"ready",choices:INGREDIENT_FIXTURES};});
afterEach(async()=>{await React.act(async()=>root.unmount());host.remove();});afterAll(()=>GlobalRegistrator.unregister());
const find=(selector:string)=>document.querySelector<HTMLElement>(selector)!;
async function click(selector:string){await React.act(async()=>find(selector).click());}
async function render(){await React.act(async()=>root.render(<div className="brief-root" data-brief-theme="dark"><div className="brief-composer-surface"><Picker catalog={catalog} selected={selected} enabled={enabled} reducedMotion onChange={s=>{selected=s;void render();}}/><textarea aria-label="Prompt"/><Chips selected={selected} onChange={s=>{selected=s;void render();}}/></div><button>Outside</button></div>));}
test("select both types, preserve search/category on reopen, remove chip without losing prompt focus",async()=>{
 await render();await click('.brief-ingredient-trigger');expect(document.activeElement).toBe(find('input'));
 await click('[role="checkbox"]');expect(selected).toHaveLength(1);expect(find('[role="checkbox"]').getAttribute('aria-checked')).toBe('true');
 await click('[role="tab"]:last-child');await click('[role="checkbox"]');expect(selected.map(s=>s.selection.kind)).toEqual(['connection','library-action']);
 const input=find('input') as HTMLInputElement;await React.act(async()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;setter.call(input,'Gmail');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await React.act(async()=>{find('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});expect(document.activeElement).toBe(find('.brief-ingredient-trigger'));
 await click('.brief-ingredient-trigger');expect((find('input') as HTMLInputElement).value).toBe('Gmail');expect(find('[role="tab"]:last-child').getAttribute('aria-selected')).toBe('true');
 await click('.brief-ingredient-chip button');expect(selected).toHaveLength(1);
});
test("missing account and uninstalled entries explain availability without granting selection",async()=>{
 await render();await click('.brief-ingredient-trigger');await click('[role="checkbox"][aria-disabled="true"]');expect(selected).toHaveLength(0);expect(find('[role="dialog"]').textContent).toContain('Account connection required');
 await click('[role="tab"]:last-child');expect(find('[role="dialog"]').textContent).toContain('Not installed');await click('[role="checkbox"][aria-disabled="true"]');expect(selected).toHaveLength(0);
});
test("off capability closes the picker and does not permit reopening; selections remain",async()=>{
 await render();await click('.brief-ingredient-trigger');await click('[role="checkbox"]');enabled=false;await render();await click('.brief-ingredient-trigger');expect(find('.brief-ingredient-trigger').getAttribute('aria-expanded')).toBe('false');expect(selected).toHaveLength(1);
});
test("rapid reversal keeps one portal and closes on outside interaction",async()=>{
 await render();for(let i=0;i<10;i++){await click('.brief-ingredient-trigger');await click('.brief-ingredient-trigger');}
 await click('.brief-ingredient-trigger');expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
 await React.act(async()=>host.lastElementChild!.dispatchEvent(new Event('pointerdown',{bubbles:true})));expect(find('.brief-ingredient-trigger').getAttribute('aria-expanded')).toBe('false');
});
