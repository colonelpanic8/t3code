import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkKeepWindowsPaths } from "./markdownPipeline.ts";
import { parseFileUrlHref } from "./fileLinks.ts";
import { safeDecodeURIComponent } from "./markdownLinks.ts";
import { isUncPath, isWindowsDrivePath, stripSlashPrefixedWindowsDrive } from "./path.ts";

const parser = unified().use(remarkParse).use(remarkKeepWindowsPaths);
interface MarkdownNode {
  readonly type: string;
  readonly url?: string | undefined;
  readonly identifier?: string | undefined;
  readonly label?: string | null | undefined;
  readonly alt?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: ReadonlyArray<MarkdownNode> | undefined;
}

// Mobile Markdown parsers consume Windows backslashes; UNC paths also need file: to
// distinguish them from protocol-relative web URLs.
function imageDestination(path: string): string {
  return isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
}

function angleDestination(path: string): string {
  return `<${path.replace(/[<>]/g, "\\$&")}>`;
}

export function appendGeneratedImageEmbeds(text: string, savedPaths: Iterable<string>): string {
  const destinations = new Set(Array.from(savedPaths, imageDestination));
  const missing = new Set(destinations);
  const definitions = new Map<string, MarkdownNode>();
  const images: Array<MarkdownNode> = [];
  const visit = (node: MarkdownNode) => {
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node);
    } else if (node.type === "image" || node.type === "imageReference") {
      images.push(node);
    }
    node.children?.forEach(visit);
  };
  parser.parse(text).children.forEach(visit);
  const edits = new Map<number, { readonly end: number; readonly text: string }>();
  for (const image of images) {
    const target = image.type === "image" ? image : definitions.get(image.identifier ?? "");
    if (target?.url === undefined) continue;
    const file = /^file:/i.test(target.url) ? parseFileUrlHref(target.url) : null;
    const path = imageDestination(
      stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(file?.path ?? target.url)),
    );
    if (!destinations.has(path)) continue;
    missing.delete(path);
    // Keep checking repeated embeds so every raw Windows destination is normalized.
    const start = target.position?.start.offset;
    const end = target.position?.end.offset;
    if (imageDestination(target.url) !== target.url && start !== undefined && end !== undefined) {
      const label =
        target.type === "image" ? (target.alt ?? "") : (target.label ?? target.identifier ?? "");
      const escapedLabel = label.replace(/[\\[\]]/g, "\\$&");
      const title = target.title == null ? "" : ` "${target.title.replace(/["\\]/g, "\\$&")}"`;
      edits.set(start, {
        end,
        text:
          target.type === "image"
            ? `![${escapedLabel}](${angleDestination(path)}${title})`
            : `[${escapedLabel}]: ${angleDestination(path)}${title}`,
      });
    }
  }
  let result = text;
  for (const [start, edit] of Array.from(edits).sort(([left], [right]) => right - left)) {
    result = result.slice(0, start) + edit.text + result.slice(edit.end);
  }
  for (const path of missing) {
    result += `${result.length > 0 ? "\n\n" : ""}![](${angleDestination(path)})`;
  }
  return result;
}
