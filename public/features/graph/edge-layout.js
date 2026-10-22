// Each horizontal bucket stores merged forbidden vertical intervals. Dense labels
// can skip a whole occupied stack instead of testing every earlier label repeatedly.
export function createLabelPlacer() {
  const columns = new Map();
  const firstEndingAfter = (ranges, y) => {
    let lo = 0, hi = ranges.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid][1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return (point, halfWidth) => {
    const first = Math.floor((point.x - halfWidth) / 64), last = Math.floor((point.x + halfWidth) / 64);
    const buckets = [];
    for (let x = first; x <= last; x++) { if (!columns.has(x)) columns.set(x, []); buckets.push(columns.get(x)); }
    const base = point.y;
    let y = base, moved;
    do {
      moved = false;
      for (const ranges of buckets) {
        const range = ranges[firstEndingAfter(ranges, y)];
        if (range && range[0] < y) {
          y = base + Math.ceil((range[1] - base) / 22) * 22;
          moved = true;
        }
      }
    } while (moved);
    for (const ranges of buckets) {
      let low = y - 22, high = y + 22;
      const start = firstEndingAfter(ranges, low);
      let end = start;
      while (end < ranges.length && ranges[end][0] <= high) { low = Math.min(low, ranges[end][0]); high = Math.max(high, ranges[end++][1]); }
      ranges.splice(start, end - start, [low, high]);
    }
    return { x: point.x, y };
  };
}
