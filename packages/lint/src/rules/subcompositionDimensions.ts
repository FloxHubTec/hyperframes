import { parseHTML } from "linkedom";
import postcss from "postcss";
import {
  parse,
  type Expression,
  type MemberExpression,
  type PrivateIdentifier,
  type SpreadElement,
  type Super,
} from "acorn";
import { simple } from "acorn-walk";
import type { HyperframeLintFinding, LintContext } from "../context";
import { readAttr, readDecodedAttr, truncateSnippet } from "../utils";

function positiveDimension(raw: string | null): number | null {
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nativeDimension(value: string, dimension: number): boolean {
  const pixels = value.trim().match(/^(\d+(?:\.\d+)?)px$/i);
  return pixels !== null && Number(pixels[1]) === dimension;
}

function changesMountLayout(property: string, rawValue: string, width: number, height: number) {
  const value = rawValue
    .replace(/!\s*important\s*$/i, "")
    .trim()
    .toLowerCase();
  switch (property.toLowerCase()) {
    case "width":
      return !nativeDimension(value, width) && !/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value);
    case "height":
      return !nativeDimension(value, height) && !/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value);
    case "inset":
    case "inset-block":
    case "inset-inline":
    case "inset-block-start":
    case "inset-block-end":
    case "inset-inline-start":
    case "inset-inline-end":
      return !/^(?:0(?:\.0+)?(?:px|%)?\s*){1,4}$/.test(value);
    case "left":
    case "top":
    case "right":
    case "bottom":
      return !/^0(?:\.0+)?(?:px|%)?$/.test(value);
    case "position":
      return value !== "absolute";
    case "transform":
      return value !== "none";
    case "scale":
      return value !== "none" && value !== "1" && value !== "1 1";
    case "zoom":
      return value !== "normal" && value !== "1" && value !== "100%";
    default:
      return /^(?:all|inset(?:-.+)?|right|bottom|translate|rotate|(?:min|max)-(?:width|height)|(?:inline|block)-size|margin(?:-.+)?|animation(?:-.+)?)$/.test(
        property.toLowerCase(),
      );
  }
}

function hasLayoutOverride(
  element: Element,
  width: number,
  height: number,
  styles: postcss.Root[],
): boolean {
  let changed = false;
  const inspect = (declaration: postcss.Declaration) => {
    if (changesMountLayout(declaration.prop, declaration.value, width, height)) changed = true;
  };
  try {
    postcss.parse(`mount { ${element.getAttribute("style") ?? ""} }`).walkDecls(inspect);
    for (const style of styles) {
      style.walkRules((rule) => {
        if (rule.parent?.type === "atrule" && /(?:^|-)keyframes$/i.test(rule.parent.name)) {
          return;
        }
        let overridesLayout = false;
        rule.walkDecls((declaration) => {
          if (changesMountLayout(declaration.prop, declaration.value, width, height)) {
            overridesLayout = true;
          }
        });
        if (!overridesLayout) return;
        if (rule.parent?.type === "rule") {
          changed = true;
          return;
        }
        const selectors = rule.selectors.filter(
          (selector) => !/::|:(?:before|after|first-letter|first-line)\b/i.test(selector),
        );
        if (selectors.some((selector) => element.matches(selector))) changed = true;
      });
    }
  } catch {
    return true;
  }
  return changed;
}

type ScriptValue = Expression | SpreadElement | PrivateIdentifier | Super | undefined;

function stringValue(node: ScriptValue): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function memberName(node: MemberExpression): string | undefined {
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : stringValue(node.property);
}

function hasLayoutProperties(node: ScriptValue): boolean {
  if (node?.type !== "ObjectExpression") return false;
  return node.properties.some((property) => {
    if (property.type !== "Property") return false;
    const name =
      !property.computed && property.key.type === "Identifier"
        ? property.key.name
        : stringValue(property.key);
    return name === "css"
      ? hasLayoutProperties(property.value)
      : name !== undefined &&
          /^(?:scale[XY]?|transform|zoom|width|height|left|top|x|y|cssText)$/.test(name);
  });
}

function isGsapTimeline(node: ScriptValue): boolean {
  if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;
  const method = memberName(node.callee);
  return method === "timeline"
    ? node.callee.object.type === "Identifier" && node.callee.object.name === "gsap"
    : /^(?:set|to|from|fromTo)$/.test(method ?? "") && isGsapTimeline(node.callee.object);
}

function scriptLayoutTargets(ctx: LintContext): ScriptValue[] {
  const targets: ScriptValue[] = [];
  for (const { content } of ctx.scripts) {
    try {
      const ast = parse(content, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowReturnOutsideFunction: true,
      });
      const timelines = new Set<string>();
      simple(ast, {
        VariableDeclarator(node) {
          if (node.id.type === "Identifier" && isGsapTimeline(node.init ?? undefined)) {
            timelines.add(node.id.name);
          }
        },
      });
      simple(ast, {
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression") return;
          const method = memberName(callee);
          if (
            method !== undefined &&
            /^(?:set|to|from|fromTo)$/.test(method) &&
            ((callee.object.type === "Identifier" &&
              (callee.object.name === "gsap" || timelines.has(callee.object.name))) ||
              isGsapTimeline(callee.object)) &&
            node.arguments.slice(1, method === "fromTo" ? 3 : 2).some(hasLayoutProperties)
          ) {
            targets.push(node.arguments[0]);
          } else if (
            method === "setProperty" &&
            callee.object.type === "MemberExpression" &&
            memberName(callee.object) === "style" &&
            /^(?:scale|transform|zoom|width|height|left|top)$/.test(
              stringValue(node.arguments[0]) ?? "",
            )
          ) {
            targets.push(callee.object.object);
          }
        },
        AssignmentExpression(node) {
          const left = node.left;
          if (
            left.type === "MemberExpression" &&
            left.object.type === "MemberExpression" &&
            memberName(left.object) === "style" &&
            /^(?:scale|transform|zoom|width|height|left|top|cssText)$/.test(memberName(left) ?? "")
          ) {
            targets.push(left.object.object);
          }
        },
      });
    } catch {
      continue;
    }
  }
  return targets;
}

function targetsMount(node: ScriptValue, element: Element): boolean {
  if (node?.type === "ArrayExpression")
    return node.elements.some((entry) => targetsMount(entry ?? undefined, element));
  let selector = stringValue(node);
  if (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "document"
  ) {
    const method = memberName(node.callee);
    const argument = stringValue(node.arguments[0]);
    if (method === "getElementById") return Boolean(element.id) && argument === element.id;
    if (method === "querySelector" || method === "querySelectorAll") selector = argument;
  }
  if (selector === undefined) return false;
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

export function subcompositionDimensionFindings(ctx: LintContext): HyperframeLintFinding[] {
  const { rootTag } = ctx;
  if (!rootTag) return [];
  const rootWidth = positiveDimension(readAttr(rootTag.raw, "data-width"));
  const rootHeight = positiveDimension(readAttr(rootTag.raw, "data-height"));
  if (rootWidth === null || rootHeight === null) return [];
  const mounts = ctx.tags.filter((tag) => readAttr(tag.raw, "data-composition-src"));
  if (mounts.length === 0) return [];

  const { document } = parseHTML(ctx.source);
  const roots = [...document.querySelectorAll("[data-composition-id]")].filter(
    (element) =>
      element.localName === rootTag.name &&
      element.getAttribute("data-composition-id") === ctx.rootCompositionId,
  );
  const root = roots.length === 1 ? roots[0] : undefined;
  if (!root) return [];
  let styles: postcss.Root[];
  try {
    styles = ctx.styles.map(({ content }) => postcss.parse(content));
  } catch {
    return [];
  }

  const findings: HyperframeLintFinding[] = [];
  let scriptTargets: ScriptValue[] | undefined;
  for (const element of root.children) {
    const source = element.getAttribute("data-composition-src");
    if (!source) continue;
    const width = positiveDimension(element.getAttribute("data-width"));
    const height = positiveDimension(element.getAttribute("data-height"));
    if (width === null || height === null) continue;
    const scale = rootWidth / width;
    if (scale === 1 || Math.abs(scale - rootHeight / height) > 0.000001) continue;
    if (hasLayoutOverride(element, width, height, styles)) continue;
    scriptTargets ??= scriptLayoutTargets(ctx);
    if (scriptTargets.some((target) => targetsMount(target, element))) continue;
    const authoredTag = mounts.find((tag) =>
      [
        "id",
        "data-composition-id",
        "data-composition-src",
        "data-width",
        "data-height",
        "style",
      ].every((name) => readDecodedAttr(tag.raw, name) === element.getAttribute(name)),
    );
    findings.push({
      code: "subcomposition_dimensions_mismatch",
      severity: "warning",
      message: `Sub-composition "${source}" retains its ${width}x${height} canvas inside the ${rootWidth}x${rootHeight} root; mounts do not scale to the root automatically.`,
      elementId: element.id || undefined,
      fixHint: `If this block should fill the root canvas, set style="position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; transform: scale(${Number(scale.toFixed(6))}); transform-origin: 0 0" on the mount. Keep its current size if the smaller placement is intentional.`,
      snippet: truncateSnippet(authoredTag?.raw ?? ""),
    });
  }
  return findings;
}
