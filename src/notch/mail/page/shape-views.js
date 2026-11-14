// The views Gmail holds in its content area, and which of them can be seen. Tags, classes, sizes.
const name = (node) => node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).slice(0, 5).join('.') : '') + (node.getAttribute('role') ? `[role=${node.getAttribute('role')}]` : '');
const area = document.querySelector('div.AO');
const views = area ? [...area.querySelectorAll('div.oy8Mbf, div.BltHke, [role="main"]')] : [];
const box = (node) => { const rect = node.getBoundingClientRect(); return `${Math.round(rect.width)}x${Math.round(rect.height)}`; };
return {
  area: !!area,
  areaBox: area ? box(area) : null,
  views: views.map((view) => ({ is: name(view), display: getComputedStyle(view).display, box: box(view), rows: view.querySelectorAll('tr.zA').length, textLength: (view.innerText || '').length })),
  // What takes up the middle of the window right now.
  middle: (() => { const node = document.elementFromPoint(Math.round(innerWidth * 0.6), Math.round(innerHeight * 0.5)); const out = []; for (let at = node; at && out.length < 8; at = at.parentElement) out.push(name(at)); return out; })(),
  window: `${innerWidth}x${innerHeight}`,
  dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((node) => node.offsetParent !== null || getComputedStyle(node).position === 'fixed').length,
};
