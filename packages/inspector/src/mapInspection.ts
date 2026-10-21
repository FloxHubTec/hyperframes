import { Sources, mergeSnippets } from "./sources";
import type { InspectRequest, RuntimeResponse, Snippet } from "./types";
const coverage = [
  "GSAP associations observed since page initialization; callback-created animations may require an explicit time query.",
  "Animation source dependencies include lexically resolved declarations in the same script; later mutations, imports, and cross-script bindings are not traced.",
  "CSS selector matches are candidates, not a full cascade or dependency graph. HTML is the authored opening tag when uniquely located.",
  "Direct constructors, other animation systems, iframe contents, removed animations and unexecuted paths may be absent; missing origins are reported.",
];
const KEPT_FIRST_UNDER_BUDGET = [
  "animation creation",
  "animation caller",
  "timeline attachment",
  "html opening tag",
  "animation source dependency",
  "matched CSS candidate",
];
const rank = (kind: string) => {
  const at = KEPT_FIRST_UNDER_BUDGET.indexOf(kind);
  return at === -1 ? KEPT_FIRST_UNDER_BUDGET.length : at;
};
const priority = (snippet: Snippet) => Math.min(...snippet.kind.map(rank));
const byPosition = (a: Snippet, b: Snippet) =>
  a.file.localeCompare(b.file) || a.startLine - b.startLine;

export function mapInspection(
  raw: RuntimeResponse,
  request: InspectRequest,
  context: {
    sources: Sources;
    map: ReturnType<Sources["mapper"]>;
    catalog: Map<string, Snippet>;
    generation: string;
    sourceVersion: string;
    reused: boolean;
    start: number;
    visualState?: { time: number | undefined; duration: number | undefined };
  },
) {
  const { sources, map, catalog, generation, sourceVersion, reused, start, visualState } = context;
  const maxBytes = request.maxBytes ?? 12000;
  const collected: Snippet[] = [];
  const compositions: Snippet[] = [];
  const results = raw.results.map((result, index) => {
    let unmappedAnimations = 0;
    for (const animation of result.animations) {
      const mapped = animation.stack ? map(animation.stack, index) : [];
      if (!mapped.length) unmappedAnimations++;
      collected.push(...mapped);
      for (const stack of animation.attachmentStacks)
        collected.push(
          ...map(stack, index).map((snippet) => ({ ...snippet, kind: ["timeline attachment"] })),
        );
    }
    for (const el of result.elements) {
      const tag = sources.markupTag(el);
      if (!tag) continue;
      const snippet = sources.slice(tag.file, tag.start, tag.end, "html opening tag", index);
      if (snippet) collected.push(snippet);
      compositions.push(...sources.compositions(tag, index));
    }
    for (const id of result.css) {
      const rule = sources.cssRules.find((rule) => rule.id === id);
      if (rule) {
        const snippet = sources.slice(
          rule.file,
          rule.start,
          rule.end,
          "matched CSS candidate",
          index,
        );
        if (snippet) collected.push(snippet);
      }
    }
    return {
      target: index,
      status: result.status,
      candidates: result.candidates,
      candidatesOmitted: 0,
      animations: result.animations.length,
      coTargets: [
        ...new Map(
          result.animations
            .flatMap((animation) => animation.targets)
            .filter((element) => !result.elements.some((own) => own.ref === element.ref))
            .map((element) => [element.ref, element]),
        ).values(),
      ].slice(0, 10),
      unmappedAnimations,
      scopeTruncated: result.truncated,
    };
  });
  const merged = withCompositionsLast(mergeSnippets(collected, sources), compositions, sources);
  for (const snippet of merged) catalog.set(snippet.id, snippet);
  let selected = [...merged].sort((a, b) => priority(a) - priority(b));
  if (request.snippets)
    selected = request.snippets.map((id) => {
      const snippet = catalog.get(id);
      if (!snippet) throw new Error(`unknown_snippet: ${id}`);
      return snippet;
    });
  const response = {
    generation: generation,
    visualState,
    sourceVersion: sourceVersion,
    reused,
    results,
    snippets: [] as Snippet[],
    omitted: [] as { id: string; bytes: number }[],
    omittedCount: 0,
    nextOffset: null as number | null,
    coverage,
    recordLimitReached: raw.recordLimitReached,
    hooked: raw.hooked,
    debugAvailable: true,
    elapsedMs: Math.round(performance.now() - start),
  };
  const offset = request.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("offset must be a non-negative integer");
  const size = () => Buffer.byteLength(JSON.stringify(response));
  const trimCandidates = (limit: number, keep: number) => {
    while (size() > limit) {
      const longest = response.results.reduce((a, b) =>
        b.candidates.length > a.candidates.length ? b : a,
      );
      if (longest.candidates.length <= keep) return;
      longest.candidates.pop();
      longest.candidatesOmitted++;
    }
  };
  trimCandidates(maxBytes / 2, 5);
  for (let i = offset; i < selected.length; i++) {
    response.snippets.push(selected[i]);
    const priorCoverage = response.coverage;
    if (
      response.coverage === coverage &&
      selected[i].kind.some(
        (kind) => kind.startsWith("composition ") && kind.endsWith(" candidate"),
      )
    )
      response.coverage = [
        ...coverage,
        "Composition candidates are alternative source mounts and their enclosing roots, not a verified runtime instance chain; all alternatives remain available within the snippet budget and pagination.",
      ];
    if (size() > maxBytes - 700) {
      response.snippets.pop();
      response.coverage = priorCoverage;
      response.omittedCount = selected.length - i;
      response.omitted = selected
        .slice(i, i + 8)
        .map((item) => ({ id: item.id, bytes: Buffer.byteLength(item.code) }));
      const nothingFit = response.snippets.length === 0;
      response.nextOffset = nothingFit ? (i + 1 < selected.length ? i + 1 : null) : i;
      break;
    }
  }
  if (!request.snippets) response.snippets.sort(byPosition);
  trimCandidates(maxBytes, 0);
  if (Buffer.byteLength(JSON.stringify(response)) > maxBytes)
    throw new Error("metadata_exceeds_budget: use fewer targets or increase maxBytes");
  if (request.debug) return { ...response, debug: raw };
  return response;
}
function withCompositionsLast(merged: Snippet[], compositions: Snippet[], sources: Sources) {
  const covered = (s: Snippet) =>
    merged.some((m) => m.file === s.file && m.startLine <= s.startLine && m.endLine >= s.endLine);
  return [
    ...merged,
    ...mergeSnippets(
      compositions.filter((s) => !covered(s)),
      sources,
    ),
  ];
}
