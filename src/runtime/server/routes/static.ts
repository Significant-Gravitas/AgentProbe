import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { safeStaticPath } from "../../../shared/utils/safe-static-path.ts";
import type { ServerContext } from "../app-server.ts";
import { DEFAULT_DASHBOARD_HTML, dashboardHtml } from "../dashboard/inline.ts";
import { errorResponse } from "../http-helpers.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

function isDashboardPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/index.html") {
    return true;
  }
  if (pathname.startsWith("/runs") || pathname.startsWith("/suites")) {
    return true;
  }
  if (pathname === "/settings") {
    return true;
  }
  return false;
}

function serveInlineDashboard(context: ServerContext): Response {
  return new Response(
    dashboardHtml({ hasToken: Boolean(context.config.token) }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-request-id": context.requestId,
        "cache-control": "no-store",
      },
    },
  );
}

export async function handleStatic(
  request: Request,
  context: ServerContext,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Distribution dashboard takes precedence when configured.
  if (context.config.dashboardDist) {
    const indexFallback = isDashboardPath(pathname);
    const relative = indexFallback ? "index.html" : pathname;
    const resolved = safeStaticPath(context.config.dashboardDist, relative);
    if (!resolved.ok) {
      return errorResponse({
        status: 400,
        type: "BadRequest",
        message: `Invalid path: ${resolved.reason}`,
        requestId: context.requestId,
      });
    }
    if (existsSync(resolved.absolutePath)) {
      const stat = statSync(resolved.absolutePath);
      if (stat.isFile()) {
        const file = Bun.file(resolved.absolutePath);
        return new Response(file, {
          status: 200,
          headers: {
            "content-type": contentTypeFor(resolved.absolutePath),
            "x-request-id": context.requestId,
            "cache-control": "no-store",
          },
        });
      }
      if (stat.isDirectory()) {
        const indexPath = join(resolved.absolutePath, "index.html");
        if (existsSync(indexPath) && statSync(indexPath).isFile()) {
          return new Response(Bun.file(indexPath), {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-request-id": context.requestId,
              "cache-control": "no-store",
            },
          });
        }
      }
    }
    if (indexFallback) {
      const indexPath = safeStaticPath(
        context.config.dashboardDist,
        "index.html",
      );
      if (indexPath.ok && existsSync(indexPath.absolutePath)) {
        return new Response(Bun.file(indexPath.absolutePath), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-request-id": context.requestId,
            "cache-control": "no-store",
          },
        });
      }
    }
  }

  if (isDashboardPath(pathname)) {
    return serveInlineDashboard(context);
  }

  if (pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-request-id": context.requestId,
      },
    });
  }

  if (pathname === "/favicon.ico") {
    return new Response("", {
      status: 204,
      headers: { "x-request-id": context.requestId },
    });
  }

  return errorResponse({
    status: 404,
    type: "NotFound",
    message: `Not found: ${pathname}`,
    requestId: context.requestId,
  });
}

export { DEFAULT_DASHBOARD_HTML };
