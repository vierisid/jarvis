/** Dimensions describe the workspace below its header, not the browser/reading column. */
export const PEBBLE_SIZE = 58;
export const PEBBLE_SPLIT_MIN = 960;
export function pebbleGeometry(width: number, height: number) {
  const single = width < PEBBLE_SPLIT_MIN;
  const inset = width < 600 ? 18 : 26;
  const panelWidth = single ? Math.max(0, width - inset * 2) : Math.min(447, Math.max(360, width - 600));
  return { single, inset, panelWidth, panelHeight: Math.max(0, height - inset * 2),
    reservedWidth: single ? 0 : panelWidth + inset };
}
