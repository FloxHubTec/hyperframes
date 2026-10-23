import { FEEDBACK_EMAIL_ENV } from "./feedbackSource.js";

export const CAPTURE_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "HYPERFRAMES_VERTEX_PROJECT_ID",
  "HYPERFRAMES_VERTEX_SERVICE_ACCOUNT",
  "HYPERFRAMES_VERTEX_LOCATION",
  "HYPERFRAMES_VERTEX_MODEL",
  "HYPERFRAMES_OPENROUTER_MODEL",
  "HYPERFRAMES_GEMINI_MODEL",
  "HYPERFRAMES_VISION_TIMEOUT_MS",
];

// A quoted value ends at its closing quote; unquoted, `#` starts a comment only after whitespace, so `pass#word` stays.
function valueOf(raw: string): string {
  const quote = raw.charAt(0);
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  const comment = raw.match(/\s+#/);
  return comment?.index === undefined ? raw : raw.slice(0, comment.index).trim();
}

function entryOf(rawLine: string): [string, string] | null {
  let line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  if (line.startsWith("export ")) line = line.slice(7).trim();
  const eq = line.indexOf("=");
  if (eq < 1) return null;
  return [line.slice(0, eq).trim(), valueOf(line.slice(eq + 1).trim())];
}

// The quote a line's value opens without closing, if any; `logicalLines` keeps
// reading further lines for it until one closes the quote.
function openQuoteOf(trimmedLine: string): string | null {
  const eq = trimmedLine.indexOf("=");
  if (eq < 1) return null;
  const valueStart = trimmedLine.slice(eq + 1).trim();
  const quote = valueStart.charAt(0);
  if (quote !== '"' && quote !== "'") return null;
  return valueStart.indexOf(quote, 1) < 0 ? quote : null;
}

// A quoted value left open at end of line continues on the lines that follow it;
// join them into one logical line so `entryOf`/`valueOf` see the whole value.
function logicalLines(content: string): string[] {
  const rawLines = content.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] ?? "";
    const quote = openQuoteOf(line.trim());
    if (quote === null) {
      lines.push(line);
      continue;
    }
    const continuation = [line];
    while (++i < rawLines.length) {
      const next = rawLines[i] ?? "";
      continuation.push(next);
      if (next.includes(quote)) break;
    }
    lines.push(continuation.join("\n"));
  }
  return lines;
}

// Never over a key already set, and never the feedback email in any letter case (Windows env names are case-blind):
// only the launching app may attach it, and an agent can write a project `.env`.
// An optional exact-name allowlist narrows callers that load less-trusted project settings.
export function applyDotEnv(
  content: string,
  env: NodeJS.ProcessEnv,
  allowedKeys?: readonly string[],
): void {
  const allowed = allowedKeys === undefined ? undefined : new Set(allowedKeys);
  for (const entry of logicalLines(content).map(entryOf)) {
    if (!entry) continue;
    const [key, value] = entry;
    if (
      key &&
      key.toUpperCase() !== FEEDBACK_EMAIL_ENV &&
      (allowed === undefined || allowed.has(key)) &&
      !(key in env)
    )
      env[key] = value;
  }
}
