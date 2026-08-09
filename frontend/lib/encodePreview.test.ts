import { describe, it, expect } from "vitest";
import { encodePreview, decodePreview } from "./encodePreview";

describe("encodePreview", () => {
  it("encodes plain text to a 0x-prefixed hex string", () => {
    expect(encodePreview("Hello")).toBe("0x48656c6c6f");
  });

  it("encodes Unicode text", () => {
    expect(encodePreview("Hello 👋")).toBe("0x48656c6c6f20f09f918b");
  });

  it("throws for empty input", () => {
    expect(() => encodePreview("")).toThrow("Preview message cannot be empty");
    expect(() => encodePreview("   ")).toThrow("Preview message cannot be empty");
  });
});

describe("decodePreview", () => {
  it("decodes a 0x-prefixed hex string", () => {
    expect(decodePreview("0x48656c6c6f")).toBe("Hello");
  });

  it("decodes a 0x-prefixed hex string with mixed case", () => {
    expect(decodePreview("0X48656C6C6F")).toBe("Hello");
  });

  it("decodes a hex string without a prefix", () => {
    expect(decodePreview("48656c6c6f")).toBe("Hello");
  });

  it("decodes Unicode hex", () => {
    expect(decodePreview("0x48656c6c6f20f09f918b")).toBe("Hello 👋");
  });

  it("passes through already-decoded plaintext", () => {
    expect(decodePreview("Already plain")).toBe("Already plain");
  });

  it("strips trailing NUL padding", () => {
    expect(decodePreview("0x48656c6c6f000000")).toBe("Hello");
  });

  it("trims surrounding whitespace", () => {
    expect(decodePreview("0x202048656c6c6f2020")).toBe("Hello");
  });

  it("returns empty for absent / empty values", () => {
    expect(decodePreview(undefined)).toBe("");
    expect(decodePreview(null)).toBe("");
    expect(decodePreview("")).toBe("");
    expect(decodePreview("   ")).toBe("");
  });

  it("returns empty for explicit zero hex values", () => {
    expect(decodePreview("0x")).toBe("");
    expect(decodePreview("0x0")).toBe("");
    expect(decodePreview("0X")).toBe("");
    expect(decodePreview("0X0")).toBe("");
  });

  it("returns empty for NUL-only hex values", () => {
    expect(decodePreview("0x00")).toBe("");
    expect(decodePreview("0x0000")).toBe("");
  });

  it("returns the raw value when hex is not valid UTF-8", () => {
    // 0xff is not a valid UTF-8 lead byte.
    expect(decodePreview("0xff")).toBe("0xff");
  });

  it("handles non-string inputs gracefully", () => {
    expect(decodePreview(123 as any)).toBe("123");
    expect(decodePreview({} as any)).toBe("[object Object]");
  });

  it("round-trips a typed message", () => {
    const message = "Hey, can we chat?";
    const encoded = encodePreview(message);
    expect(decodePreview(encoded)).toBe(message);
  });
});
