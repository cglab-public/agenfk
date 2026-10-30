/**
 * The image an Airlock machine is made from (CGLAB-696): an OCI image
 * reference, `[registry[:port]/]name[/name...][:tag][@sha256:digest]`, in
 * lower case. It is handed to smolvm as an argument, so nothing else passes:
 * no spaces, nothing starting with a dash, no empty path component.
 */
const PART = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const REGISTRY = `${PART}(?:\\.${PART})*(?::[0-9]{1,5})?`;
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_REF = new RegExp(
  `^(?:${REGISTRY}/)?${COMPONENT}(?:/${COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);
const MAX_IMAGE_REF = 255;

export function isAirlockImageRef(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_IMAGE_REF && IMAGE_REF.test(v);
}
