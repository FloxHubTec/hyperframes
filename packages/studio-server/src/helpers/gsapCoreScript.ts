export function isGsapCoreUrl(src: string): boolean {
  const base = "http://localhost/";
  return (
    URL.canParse(src, base) &&
    /\/gsap(-\d+(\.\d+)*)?(\.min)?\.js$/i.test(new URL(src, base).pathname)
  );
}

const TEMPLATE_ELEMENT = /<template\b[^>]*>[\s\S]*?<\/template>/gi;
const SCRIPT_SRC = /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const INLINED_MARKER = /\/\*\s*inlined:\s*(\S+)\s*\*\//gi;
const CORE_LICENSE_BANNER = /\/\*!\s*\*\s*GSAP\s+\d/;
const AUTHORED_CORE_CALL = /\bgsap\.(config|defaults|registerPlugin|version)\b/;

// A plugin (MotionPathPlugin, CustomEase) needs core loaded first, so it never counts as core.
export function htmlHasGsapCore(html: string): boolean {
  const live = html.replace(TEMPLATE_ELEMENT, "");
  const srcs = [...live.matchAll(SCRIPT_SRC)].map((m) =>
    (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/gi, "&"),
  );
  const inlinedSrcs = [...live.matchAll(INLINED_MARKER)].map((m) => m[1] ?? "");
  return (
    [...srcs, ...inlinedSrcs].some(isGsapCoreUrl) ||
    CORE_LICENSE_BANNER.test(live) ||
    AUTHORED_CORE_CALL.test(live)
  );
}
