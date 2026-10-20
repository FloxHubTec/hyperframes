import { Ajv2020 } from "ajv/dist/2020.js";
import registrySchema from "@hyperframes/core/schemas/registry.json";
import itemSchema from "@hyperframes/core/schemas/registry-item.json";
import type { RegistryManifest, RegistryItem, ItemType } from "@hyperframes/core";

// Compiled on first use: projectConfig imports the registry, so compiling at load delayed check's start by ~50 ms.
function compileShapes() {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return {
    manifest: ajv.compile<RegistryManifest>(registrySchema),
    item: ajv.compile<RegistryItem>(itemSchema),
  };
}
let shapes: ReturnType<typeof compileShapes> | undefined;

export function validRegistryName(name: string): boolean {
  return name.length <= 128 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name);
}

export function validRegistryManifest(value: unknown): value is RegistryManifest {
  return (
    (shapes ??= compileShapes()).manifest(value) &&
    value.items.length <= 10_000 &&
    value.items.every((item) => validRegistryName(item.name))
  );
}

export function validRegistryItem(
  value: unknown,
  name: string,
  type: ItemType,
): value is RegistryItem {
  return (
    (shapes ??= compileShapes()).item(value) &&
    value.name === name &&
    value.type === type &&
    validRegistryName(value.name) &&
    value.files.length <= 1_000
  );
}
