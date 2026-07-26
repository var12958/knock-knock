import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Lightweight route guard for the KnockKnock onboarding flow.
 *
 * This middleware checks for a session cookie set by the client-side
 * FirebaseAuthContext. It is a UX convenience redirect, not a security
 * boundary: the real authorization is enforced by Firebase Auth, RTDB
 * rules, and the verifyFCCOnboarding Cloud Function.
 */

const PUBLIC_PATHS = new Set([
  "/onboard",
  "/_next",
  "/favicon.ico",
  "/api/setSession",
  "/api/clearSession",
]);

function isPublic(path: string): boolean {
  for (const publicPath of Array.from(PUBLIC_PATHS)) {
    if (path === publicPath || path.startsWith(`${publicPath}/`)) {
      return true;
    }
  }
  return false;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get("kk_uid")?.value;
  if (!sessionCookie) {
    const onboardUrl = new URL("/onboard", request.url);
    return NextResponse.redirect(onboardUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
