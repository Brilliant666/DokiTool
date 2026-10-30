import type { Variant } from "../types/media";

/** Facts only: keep conflicting layers visible instead of inventing a combined ranking. */
export function variantSpecifications(variant: Variant): string[] {
  if (variant.state === "deferred") return [];
  const layers = [
    variant.metadata,
    ...("resources" in variant.delivery ? variant.delivery.resources.map((resource) => resource.metadata) : []),
  ];
  const hdrLabels = {
    sdr: "SDR", hdr10: "HDR10", hdr10_plus: "HDR10+",
    hlg: "HLG", dolby_vision: "Dolby Vision", hdr_unknown: "HDR",
  };
  const specifications = layers.flatMap((metadata) => metadata ? [
      metadata.width && metadata.height ? `${metadata.width}×${metadata.height}` : "",
      metadata.fps ? `${metadata.fps} fps` : "",
      metadata.hdr_type ? hdrLabels[metadata.hdr_type] : "",
      metadata.video_codec || "",
      metadata.audio_language || "",
      metadata.audio_channels ? `${metadata.audio_channels} ch` : "",
    ].filter(Boolean) : [],
  );
  return [...new Set(specifications)];
}

/** Presentation only: never selects a default or merges delivery identities. */
export function groupVariantsForDisplay(variants: Variant[]): Variant[][] {
  const groups = new Map<string, Variant[]>();
  for (const variant of variants) {
    const metadata = variant.state === "deferred" ? undefined : variant.metadata;
    const canGroup =
      variant.state !== "deferred" &&
      variant.delivery.kind === "file" &&
      variant.provenance !== "original_endpoint" &&
      metadata?.width && metadata.height;
    const key = canGroup
      ? JSON.stringify(["resolution", metadata.width, metadata.height])
      : JSON.stringify(["variant", variant.id]);
    const group = groups.get(key);
    if (group) group.push(variant);
    else groups.set(key, [variant]);
  }
  return [...groups.values()];
}
/** Display backend metadata without ranking or changing the selected version. */
export function variantLabel(
  variant: Variant | undefined,
  locale = "zh-CN",
): string {
  if (!variant) return locale === "en" ? "Unknown quality" : "画质未知";
  if (variant.label) return variant.label;
  const { width, height } =
    variant.state === "deferred" ? {} : variant.metadata || {};
  return width && height
    ? `${Math.min(width, height)}p`
    : locale === "en"
      ? "Unknown quality"
      : "画质未知";
}
export function formatMediaSize(size: unknown, locale = "zh-CN"): string {
  const bytes =
    typeof size === "number" || (typeof size === "string" && size.trim())
      ? Number(size)
      : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    return locale === "en" ? "Size unknown" : "大小未知";
  if (bytes < 100000) return "<0.1 MB";
  return `${(bytes / 1000000).toFixed(1)} MB`;
}
