import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { middleware } from "./middleware";

function makeRequest(pathname: string, cookies: Record<string, string> = {}) {
  const url = new URL(`https://example.com${pathname}`);
  return {
    nextUrl: url,
    url: url.toString(),
    cookies: {
      get: (name: string) => ({ value: cookies[name] } as any),
    },
  } as any;
}

describe("middleware", () => {
  it("redirects protected paths to /onboard when the session cookie is missing", () => {
    const response = middleware(makeRequest("/send"));
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("location")).toBe("https://example.com/onboard");
  });

  it("allows protected paths when the session cookie is present", () => {
    const response = middleware(makeRequest("/send", { kk_uid: "user-123" }));
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("location")).toBeNull();
  });

  it("allows public paths without a session cookie", () => {
    const response = middleware(makeRequest("/onboard"));
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("location")).toBeNull();
  });

  it("allows static Next.js assets", () => {
    const response = middleware(makeRequest("/_next/static/chunk.js"));
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("location")).toBeNull();
  });
});
