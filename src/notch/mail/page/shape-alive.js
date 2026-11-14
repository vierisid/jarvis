// Is the page being drawn? A page in a window that is covered or minimised is put to sleep by the browser.
const frames = await new Promise((resolve) => {
  let count = 0;
  const tick = () => { count++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve(count), 1000);
});
const started = performance.now();
await new Promise((resolve) => setTimeout(resolve, 100));
return {
  visibility: document.visibilityState,
  focus: document.hasFocus(),
  framesInOneSecond: frames,
  timerOf100msTook: Math.round(performance.now() - started),
  online: navigator.onLine,
  alerts: [...document.querySelectorAll('[role="alert"]')].filter((node) => node.offsetParent !== null && (node.textContent || '').trim()).length,
};
