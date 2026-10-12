import { createInterface } from "node:readline/promises";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  ember: (s: string) => (useColor ? `\x1b[38;5;208m${s}\x1b[39m` : s),
};

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = all.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, visible(cell))), []);
  const fmt = (row: string[]) => row.map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - visible(cell))).join("  ").trimEnd();
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, c.dim(widths.map((w) => "─".repeat(w)).join("  ")));
  return lines.join("\n");
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} ${c.dim("[y/N]")} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
