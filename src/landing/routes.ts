import bundledAssets from "./assets.json";
import { landingPage, siteOrigin } from "./page";

// A fixed allowlist serves compiled bytes without exposing repository files.
const assets = new Map([
  ["/assets/slop-sheriff-hero.webp", { type: "image/webp", bytes: Buffer.from(bundledAssets["slop-sheriff-hero.webp"], "base64") }],
  ["/assets/slop-sheriff-icon.png", { type: "image/png", bytes: Buffer.from(bundledAssets["slop-sheriff-icon.png"], "base64") }],
  ["/assets/slop-sheriff-social.jpg", { type: "image/jpeg", bytes: Buffer.from(bundledAssets["slop-sheriff-social.jpg"], "base64") }],
]);

export const landingPaths = ["/", "/robots.txt", "/sitemap.xml", ...assets.keys()];

export function landingResponse(request: Request, environment = process.env.VERCEL_ENV): Response {
  const url = new URL(request.url);
  const pathname = url.pathname;
  // Deployment metadata and an exact canonical hostname are both required.
  // The request never supplies the canonical URL or an allowed hostname.
  const indexable = environment === "production" && url.hostname === new URL(siteOrigin).hostname;
  const headers = new Headers({
    "cache-control": "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    "x-robots-tag": indexable ? "index, follow" : "noindex, nofollow",
  });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  let body: string | Uint8Array<ArrayBuffer>;
  if (pathname === "/") {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    body = landingPage(indexable, process.env.VERCEL_GIT_COMMIT_SHA);
  } else if (pathname === "/robots.txt") {
    headers.set("content-type", "text/plain; charset=utf-8");
    body = indexable ? `User-agent: *\nAllow: /$\nAllow: /assets/\nDisallow: /eve/\nSitemap: ${siteOrigin}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n";
  } else if (pathname === "/sitemap.xml") {
    headers.set("content-type", "application/xml; charset=utf-8");
    body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexable ? `<url><loc>${siteOrigin}/</loc></url>` : ""}</urlset>`;
  } else {
    const asset = assets.get(pathname);
    if (!asset) return new Response(null, { status: 404, headers });
    headers.set("content-type", asset.type);
    body = Uint8Array.from(asset.bytes);
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
