/**
 * Cloud Function environment configuration.
 */

export const FLARE_RPC_URL =
  process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

export const MAILBOX_ADDRESS =
  process.env.MAILBOX_ADDRESS ?? "";

export function assertConfig(): void {
  if (!MAILBOX_ADDRESS || MAILBOX_ADDRESS === "0x" + "0".repeat(40)) {
    throw new Error("MAILBOX_ADDRESS is not configured");
  }
}
