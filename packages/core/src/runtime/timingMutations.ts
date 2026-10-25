import { HF_AUDIO_GROUP_TAG } from "../audioGroups";

// Read for timing beyond their attributes; scripts can register timelines.
const TIMING_ELEMENTS = ["video", "audio", "source", "script", HF_AUDIO_GROUP_TAG];

// Attribute records arrive pre-filtered to `timingAttributes`; a child-list record counts only
// when a node it adds or removes is or holds a timing element, so text edits never do.
export function createTimingRecordFilter(
  timingAttributes: readonly string[],
): (records: readonly MutationRecord[]) => boolean {
  const selector = [...TIMING_ELEMENTS, ...timingAttributes.map((name) => `[${name}]`)].join(",");
  const carriesTiming = (node: Node): boolean =>
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).matches(selector) || (node as Element).querySelector(selector) !== null);
  return (records) =>
    records.some(
      (record) =>
        record.type === "attributes" ||
        Array.from(record.addedNodes).some(carriesTiming) ||
        Array.from(record.removedNodes).some(carriesTiming),
    );
}
