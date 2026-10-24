export function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function wordErrors(reference: string, hypothesis: string) {
  const expected = words(reference);
  const actual = words(hypothesis);
  const distances = Array.from({ length: expected.length + 1 }, () => Array<number>(actual.length + 1).fill(0));
  for (let i = 0; i <= expected.length; i++) distances[i][0] = i;
  for (let j = 0; j <= actual.length; j++) distances[0][j] = j;
  for (let i = 1; i <= expected.length; i++) {
    for (let j = 1; j <= actual.length; j++) {
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + Number(expected[i - 1] !== actual[j - 1]),
      );
    }
  }
  let i = expected.length, j = actual.length;
  let substitutions = 0, deletions = 0, insertions = 0;
  while (i || j) {
    if (i && j && expected[i - 1] === actual[j - 1]) { i--; j--; }
    else if (i && j && distances[i][j] === distances[i - 1][j - 1] + 1) { substitutions++; i--; j--; }
    else if (i && distances[i][j] === distances[i - 1][j] + 1) { deletions++; i--; }
    else { insertions++; j--; }
  }
  const errors = substitutions + deletions + insertions;
  return {
    words: expected.length, errors, substitutions, deletions, insertions,
    wer: expected.length ? errors / expected.length : (errors ? null : 0),
  };
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("Cannot take the median of an empty sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
