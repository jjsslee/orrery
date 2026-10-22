/**
 * Fits a resource name into a few lines of a node card. Lines break after the
 * separators names are built from (- _ . / :); a name that still does not fit
 * keeps its opening lines and ends with "…" plus as much of its end as fits,
 * so both the prefix and the distinguishing end (…-dev / …-prod) stay visible.
 */
const NAME_FONT = '600 12.5px'; // .rnode-name
let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, string[]>();

function width(text: string): number {
  if (ctx === undefined) {
    ctx = document.createElement('canvas').getContext('2d');
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
    if (ctx) ctx.font = `${NAME_FONT} ${family}`;
  }
  return ctx ? ctx.measureText(text).width : text.length * 7;
}

/** Greedy wrap at separators; a run wider than a whole line is split by characters. */
function wrap(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of text.match(/[^-_./:]+[-_./:]*|[-_./:]+/g) ?? []) {
    if (width(line + part) <= maxWidth) {
      line += part;
      continue;
    }
    if (line) lines.push(line);
    let rest = part;
    while (rest.length > 1 && width(rest) > maxWidth) {
      let n = rest.length - 1;
      while (n > 1 && width(rest.slice(0, n)) > maxWidth) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

export function fitName(name: string, maxWidth: number, maxLines = 2): string[] {
  const key = `${maxWidth}|${maxLines}|${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let lines = wrap(name, maxWidth);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const rest = name.slice(head.join('').length);
    let tail = rest.length - 1;
    while (tail > 1 && width(`…${rest.slice(rest.length - tail)}`) > maxWidth) tail--;
    lines = [...head, `…${rest.slice(rest.length - tail)}`];
  }
  cache.set(key, lines);
  return lines;
}
