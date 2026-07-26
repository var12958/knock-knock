import { expect, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import "@testing-library/jest-dom";

expect.extend(matchers);

// Provide minimal window.ethereum for Web3Context tests without replacing jsdom's window.
(globalThis as any).ethereum = {
  request: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};
