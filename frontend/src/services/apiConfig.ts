import type { PlatformKey } from "../types/api";

export function resolveApiConfig(env: Record<string, string | undefined>) {
  const mode = (env.VITE_API_MODE || "php").trim();
  if (mode !== "php" && mode !== "secure") {
    throw new Error("VITE_API_MODE must be php or secure");
  }
  const baseUrl = (env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
  // Empty means same origin. An explicit base must be an HTTP(S) origin,
  // never a media proxy or an /api/v1 endpoint.
  if (baseUrl && !/^https?:\/\/[^/?#]+$/i.test(baseUrl)) {
    throw new Error("VITE_API_BASE_URL must be empty or an HTTP(S) origin");
  }
  const paths: Record<PlatformKey, string> = {
    all: "/api/short_videos",
    douyin: "/api/douyin",
    kuaishou: "/api/ksjx",
    bilibili: "/api/bilibili",
    xhs: "/api/xhsjx",
    toutiao: "/api/toutiao",
    // These registered parsers are reached through the existing aggregate API.
    weibo: "/api/short_videos",
    pipixia: "/api/short_videos",
    pipigx: "/api/short_videos",
    zuiyou: "/api/short_videos",
  };
  const endpoints = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, baseUrl + path]),
  ) as Record<PlatformKey, string>;
  return { mode, baseUrl, endpoints };
}

export const apiConfig = resolveApiConfig(import.meta.env);
