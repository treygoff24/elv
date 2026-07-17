function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export function nearest(token: string, candidates: string[], maxDistance = 2): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshtein(token, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= maxDistance ? best : undefined;
}

// Agents commonly abbreviate long operation IDs, so rank substring matches before
// edit distance and scale the fallback threshold to identifier length.
export function suggestIds(token: string, candidates: string[], limit = 3): string[] {
  const needle = token.toLowerCase();
  const substring = candidates
    .filter((c) => c.toLowerCase().includes(needle))
    .sort((a, b) => a.length - b.length);
  if (substring.length > 0) return substring.slice(0, limit);

  return candidates
    .map((c) => [c, levenshtein(needle, c.toLowerCase())] as const)
    .filter(([c, d]) => d <= Math.max(2, Math.floor(c.length / 4)))
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([c]) => c);
}
