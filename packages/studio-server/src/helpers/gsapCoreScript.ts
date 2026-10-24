/**
 * True for the GSAP core file (gsap.js, gsap.min.js, or a vendored gsap-3.14.2.min.js)
 * at any host or path; false for plugins like MotionPathPlugin.
 */
export function isGsapCoreUrl(src: string): boolean {
  const base = "http://localhost/";
  return (
    URL.canParse(src, base) &&
    /\/gsap(-\d+(\.\d+)*)?(\.min)?\.js$/i.test(new URL(src, base).pathname)
  );
}

/**
 * Whether the page already loads GSAP core. A plugin script such as
 * `gsap@3/dist/MotionPathPlugin.min.js` does not count: plugins need core loaded
 * first, so they are not a reason to skip loading it.
 */
export function htmlHasGsapCore(html: string): boolean {
  // Scripts inside <template> are inert when cloned and don't make GSAP global.
  const outsideTemplates = html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "");
  const srcs = [
    ...outsideTemplates.matchAll(/<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi),
  ].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/gi, "&"));
  const inlinedSrcs = [...outsideTemplates.matchAll(/\/\*\s*inlined:\s*(\S+)\s*\*\//gi)].map(
    (m) => m[1] ?? "",
  );
  return (
    [...srcs, ...inlinedSrcs].some(isGsapCoreUrl) ||
    // Core's license banner; plugin builds open with their own name instead.
    /\/\*!\s*\*\s*GSAP\s+\d/.test(outsideTemplates) ||
    // Authored calls that only work once core is global.
    /\bgsap\.(config|defaults|registerPlugin|version)\b/.test(outsideTemplates)
  );
}
