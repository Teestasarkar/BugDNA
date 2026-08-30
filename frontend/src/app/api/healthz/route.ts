/**
 * Container health check.
 *
 * The Docker HEALTHCHECK for the web image hits this. Deliberately does not
 * touch the API: this endpoint answers "is the Next.js server serving", and
 * conflating that with "is the backend up" would take the frontend container out
 * of rotation whenever the API restarted.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "bugdna-web",
    timestamp: new Date().toISOString(),
  });
}
