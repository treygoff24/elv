// Did-you-mean suggestions for mistyped commands, flags, and operation ids.
// Used by the CLI error boundary (unknown command/option) and the operation
// runner (unknown operation_id) to turn a dead-end into a corrected command.

export function levenshtein(a: string, b: string): number {
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
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

// Nearest candidate within maxDistance (default 2), or undefined. For short
// tokens — command names, flag spellings — where a typo is a char or two off.
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

// Suggestions for long identifiers (operation ids). A typed prefix/substring of
// a real id is the common agent miss (`text_to_speech` for `text_to_speech_full`),
// so substring matches rank first by length; edit-distance is the fallback,
// scaled to id length so a one-char slip in a long id still matches.
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
