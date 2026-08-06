// Package brand holds the shared Monochrome Lab styling (hosting repo's
// DESIGN.md, Brand Book III) used by every local webview page the project
// ships — the sidecar's connect shell, token form, settings, logs, account
// loading shell, and the installer's wizard. One source for the token set and
// the Pebble so the pages can't drift from each other or from the hosted
// dashboard, which ports the same vocabulary from the design system of record.
//
// Tokens mirror the dashboard's tokens.css: neutrals carry the UI, the four
// state hues are the only chroma (AA `-tx` variants for colored text), dark
// follows the OS. There is no data-theme toggle on these pages — the OS
// preference is the only input, hence plain @media blocks.
//
// --rule-hi is a local extension (hover borders; not in the dashboard's token
// set — light value inherited from the old settings CSS, dark value chosen
// between --rule and --faint). If the dashboard ever grows its own --rule-hi,
// adopt its values.
package brand

// TokensCSS is the token set + page base. Every local page opens its
// <style> with this.
const TokensCSS = `
  :root {
    color-scheme: light dark;
    --bg:#FAFBFC; --raise:#FFFFFF; --panel:#EFF2F5; --panel2:#F6F8FA;
    --rule:#E2E7EC; --rule2:#EDF0F3; --rule-hi:#D2D9E0;
    --ink:#13161A; --ink2:#535B63; --ink3:#677077; --faint:#9AA2AB;
    --listen:#E63B2E; --speak:#2D78FF; --hold:#EAA40E; --ok:#2FA45E;
    --listen-tx:#C2301F; --speak-tx:#1E5FD8; --hold-tx:#8A6206; --ok-tx:#1F7A43;
    --sh-sm:0 1px 2px rgba(20,30,45,.06),0 1px 1px rgba(20,30,45,.04);
    --sh-md:0 2px 6px rgba(20,30,45,.06),0 10px 24px -10px rgba(20,30,45,.18);
    --sans:'Familjen Grotesk', system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono:'Spline Sans Mono', ui-monospace, "Cascadia Code", Consolas, monospace;
    --corner:14px 3px 14px 14px; --corner-sm:9px 2px 9px 9px;
    --ease:cubic-bezier(.2,.7,.2,1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#121417; --raise:#1A1D22; --panel:#16191E; --panel2:#1E2128;
      --rule:#272C33; --rule2:#21252B; --rule-hi:#333A43;
      --ink:#EEF1F4; --ink2:#A4ABB3; --ink3:#8A919A; --faint:#5C636B;
      --listen-tx:#FF6A5C; --speak-tx:#6FA4FF; --hold-tx:#F0B53C; --ok-tx:#52C97F;
      --sh-sm:0 1px 2px rgba(0,0,0,.4);
      --sh-md:0 10px 24px -10px rgba(0,0,0,.6);
    }
  }
  * { box-sizing: border-box; }
  ::selection { background: rgba(230,59,46,.24); }
  body {
    margin: 0; font-family: var(--sans);
    background: var(--bg); color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
`

// PebbleCSS is the Pebble (the brand's one living object — one per screen),
// its bloom, and the wordmark. Markup contract:
//
//	<span class="bdrop"><span class="in"></span><span class="ring"></span></span>
//
// states via s-think / s-done / s-err on .bdrop; size via inline width/height.
//
//	<span class="word"><span class="u">use</span>jarvis</span>
const PebbleCSS = `
  .bdrop {
    display: block; position: relative;
    border-radius: 50% 50% 50% 12px; transform: rotate(45deg);
    background: rgba(255,255,255,.08); border: .5px solid rgba(255,255,255,.5);
    box-shadow: inset 1.5px 1.5px 1.5px rgba(255,255,255,.9), 0 6px 18px -4px rgba(20,30,45,.3);
  }
  @media (prefers-color-scheme: dark) {
    .bdrop {
      border-color: rgba(255,255,255,.4);
      box-shadow: inset 1.5px 1.5px 1.5px rgba(255,255,255,.55), 0 8px 22px -4px rgba(0,0,0,.6);
    }
  }
  .bdrop .in {
    position: absolute; inset: 0; border-radius: inherit;
    background: radial-gradient(circle at 50% 40%, #ff6e60, #e63b2e 58%, #b81e16);
    animation: brS 2.6s var(--ease) infinite;
  }
  .bdrop .ring {
    position: absolute; inset: -2px; border-radius: inherit; opacity: 0;
    background: conic-gradient(from 0deg, transparent 0 200deg, rgba(255,255,255,.98) 300deg, transparent 360deg);
    -webkit-mask: radial-gradient(circle, transparent 38%, #000 46%, #000 56%, transparent 64%);
    mask: radial-gradient(circle, transparent 38%, #000 46%, #000 56%, transparent 64%);
  }
  .bdrop.s-think .in { background: radial-gradient(circle at 50% 40%, #fff, #e6eaef 70%); animation: none; }
  .bdrop.s-think .ring { opacity: .95; animation: spin 3.4s linear infinite; }
  .bdrop.s-done .in { background: radial-gradient(circle at 50% 40%, #56c98a, #2fa45e 60%, #1f7e45); }
  .bdrop.s-err .in { animation: brS 1.2s var(--ease) infinite; }
  @keyframes brS { 0%,100% { opacity:.62; transform: scale(.96); } 50% { opacity:1; transform: scale(1.05); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bbloom {
    position: absolute; border-radius: 50%;
    background: radial-gradient(circle, rgba(230,59,46,.24), transparent 66%);
    filter: blur(10px); pointer-events: none;
  }
  .bbloom.ok { background: radial-gradient(circle, rgba(47,164,94,.26), transparent 66%); }
  .word { font-weight: 700; letter-spacing: -.045em; color: var(--ink); }
  .word .u { color: var(--ink3); }
  @media (prefers-reduced-motion: reduce) {
    .bdrop .in, .bdrop.s-think .ring { animation: none; }
  }
`
