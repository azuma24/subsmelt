/** Round a positive step up to 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Y-axis ticks from 0 to a clean ceiling at or above `max`, about `count` intervals. */
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / count);
  const top = Math.ceil(max / step) * step;
  const intervals = Math.round(top / step);
  return Array.from({ length: intervals + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/**
 * Indices of the bars that get an x-axis date label, at least `minGap` pixels
 * apart and counted back from the newest bar so today is always labelled.
 */
export function sampledLabels(count: number, band: number, minGap: number): number[] {
  if (count === 0) return [];
  const every = Math.max(1, Math.ceil(minGap / Math.max(band, 0.001)));
  const picked: number[] = [];
  for (let i = count - 1; i >= 0; i -= every) picked.unshift(i);
  return picked;
}

/** A bar with its data end (the top) rounded and its baseline square. */
export function topRoundedBar(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** Axis token label: 0, 950, 12k, 2.5k, 1.2M. */
export function axisTokens(v: number): string {
  if (v >= 1_000_000) return `${trim(v / 1_000_000, 2)}M`;
  if (v >= 1_000) return `${trim(v / 1_000, 1)}k`;
  return trim(v, 0);
}

/** Axis dollar label: $0, $0.005, $0.25, $12. */
export function axisCost(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${trim(v, 4)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${trim(v, 0)}`;
}
