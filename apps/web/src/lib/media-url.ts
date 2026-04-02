"use client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

function getAccessToken() {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("access_token");
  return typeof token === "string" && token.trim().length > 0 ? token : null;
}

export function withAccessToken(url: string) {
  const token = getAccessToken();
  if (!token) return url;

  try {
    const base =
      typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const parsed = new URL(url, base);
    if (!parsed.searchParams.has("access_token")) {
      parsed.searchParams.set("access_token", token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

export function buildTrackCoverUrl(trackId: string) {
  return withAccessToken(`${API_URL}/tracks/${trackId}/cover`);
}
