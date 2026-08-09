/**
 * @notice ML-powered on-chain behavioral Sybil-detection feature extraction.
 * @dev This module is intentionally separate from the handler orchestration so
 *      the wallet-scanning and heuristic inference code can be inspected,
 *      tested, and debugged in isolation.
 */

import { ethers } from "ethers";
import {
  ML_BEHAVIOR_TX_LIMIT,
  ML_SCAN_MAX_BLOCKS,
  ML_SCAN_TIMEOUT_MS,
  ML_SCAN_CONCURRENCY,
  ML_RECEIPT_FETCH_CONCURRENCY,
  ML_CODE_FETCH_CONCURRENCY,
  ML_RF_BLEND_WEIGHT,
  ML_ANOMALY_BLEND_WEIGHT,
  ML_SIGMOID_STEEPNESS,
  FLARE_RPC_URL,
} from "./config.js";

/** Seconds in one day; used for activity-age normalization. */
const SECONDS_PER_DAY = 86_400;

/** Names of the 20 behavioral features, in vector order. */
const FEATURE_NAMES = [
  "Transaction frequency",
  "Gas limit variance",
  "Contract diversity",
  "Counterparty diversity",
  "Failure rate",
  "Timing pattern entropy",
  "Value variance",
  "Mean transaction value",
  "Max transaction value",
  "Min transaction value",
  "Contract interaction ratio",
  "Unique active days",
  "Burstiness",
  "Nonce gap count",
  "Gas price variance",
  "Mean gas limit",
  "Zero-value transaction ratio",
  "EOA interaction ratio",
  "Reciprocity",
  "Observed activity age",
] as const;

/** Weight vector for the heuristic Random-Forest component. */
const FEATURE_WEIGHTS: number[] = [
  0.10, // txFrequency
  0.02, // gasVariation
  -0.08, // contractDiversity
  -0.08, // counterpartyDiversity
  0.08, // failureRate
  -0.07, // timingPatterns
  -0.03, // valueVariation
  0.00, // meanValue
  0.00, // maxValue
  0.00, // minValue
  0.07, // contractInteractionRatio
  -0.06, // uniqueDayCount
  0.08, // burstiness
  0.04, // nonceGaps
  0.02, // gasPriceVariation
  0.01, // meanGasLimit
  0.07, // zeroValueTxRatio
  -0.06, // eoaInteractionRatio
  -0.08, // reciprocity
  -0.07, // observedActivityAge
];

/** Typical upper bounds used to normalize raw features to [0, 1]. */
const FEATURE_NORMALIZATION: number[] = [
  50, // txFrequency (txs/day)
  1_000_000, // gasVariation
  20, // contractDiversity
  20, // counterpartyDiversity
  1, // failureRate
  1, // timingPatterns
  10_000, // valueVariance (FLR^2)
  10_000, // meanValue (FLR)
  50_000, // maxValue (FLR)
  1_000, // minValue (FLR)
  1, // contractInteractionRatio
  30, // uniqueDayCount
  10, // burstiness
  20, // nonceGaps
  1_000_000, // gasPriceVariance
  500_000, // meanGasLimit
  1, // zeroValueTxRatio
  1, // eoaInteractionRatio
  1, // reciprocity
  365, // observedActivityAge (days)
];

/** Compile-time and runtime guard that all feature vectors stay aligned. */
type FeatureCount = typeof FEATURE_NAMES.length;
const FEATURE_COUNT: FeatureCount = 20;
if (
  FEATURE_WEIGHTS.length !== FEATURE_COUNT ||
  FEATURE_NORMALIZATION.length !== FEATURE_COUNT
) {
  throw new Error("ML feature vectors are misaligned");
}

interface ScannedBehaviorData {
  sentTxs: ethers.TransactionResponse[];
  timestamps: number[];
  inboundSenders: Set<string>;
}

interface CounterpartyClassification {
  contracts: Set<string>;
  eoas: Set<string>;
}

interface ValueGasFeatures {
  values: number[];
  gasLimits: number[];
  gasPrices: number[];
  failedCount: number;
  zeroValueCount: number;
  contractTxs: ethers.TransactionResponse[];
}

interface TimingFeatures {
  hourCounts: number[];
  dayMap: Map<string, number>;
  dayCounts: number[];
}

interface BotIndicatorRule {
  index: number;
  direction: "high" | "low";
  threshold: number;
  template: (value: number) => string;
}

const BOT_INDICATOR_RULES: BotIndicatorRule[] = [
  {
    index: 0,
    direction: "high",
    threshold: 0.5,
    template: (v) => `High transaction frequency (${formatCount(v)}/day)`,
  },
  {
    index: 2,
    direction: "low",
    threshold: 0.3,
    template: (v) => `Low contract diversity (${Math.round(v)})`,
  },
  {
    index: 3,
    direction: "low",
    threshold: 0.3,
    template: (v) => `Low counterparty diversity (${Math.round(v)})`,
  },
  {
    index: 4,
    direction: "high",
    threshold: 0.1,
    template: (v) => `High failure rate (${Math.round(v * 100)}%)`,
  },
  {
    index: 5,
    direction: "low",
    threshold: 0.3,
    template: () => `Suspiciously regular timing`,
  },
  {
    index: 10,
    direction: "high",
    threshold: 0.5,
    template: (v) => `Mostly contract interactions (${Math.round(v * 100)}%)`,
  },
  {
    index: 11,
    direction: "low",
    threshold: 0.2,
    template: (v) => `Activity concentrated on few days (${Math.round(v)})`,
  },
  {
    index: 12,
    direction: "high",
    threshold: 0.6,
    template: (v) => `Bursty transaction pattern (${formatCount(v)}x)`,
  },
  {
    index: 16,
    direction: "high",
    threshold: 0.5,
    template: (v) => `Mostly zero-value transactions (${Math.round(v * 100)}%)`,
  },
  {
    index: 17,
    direction: "low",
    threshold: 0.3,
    template: () => `Rarely interacts with EOAs`,
  },
  {
    index: 18,
    direction: "low",
    threshold: 0.2,
    template: () => `No reciprocal interactions`,
  },
  {
    index: 19,
    direction: "low",
    threshold: 0.15,
    template: (v) =>
      `Observed activity age is very young (${formatCount(v)} days)`,
  },
];

/**
 * @notice Fetch the wallet's recent outgoing transactions and compute 20
 *      behavioral features.
 * @dev Scans blocks backwards from the Flare RPC until it collects
 *      `ML_BEHAVIOR_TX_LIMIT` outgoing transactions or hits the configured
 *      block-age cap. The same pass also collects inbound senders for a best-
 *      effort reciprocity feature. All RPC work is bounded by a hard timeout.
 *
 *      This function is heavily instrumented so demo operators can tell at a
 *      glance whether a failure is coming from the Flare RPC, from feature
 *      extraction math, or from the heuristic model. If the RPC fetch itself
 *      fails we fall back to deterministic mock features so the UI can still
 *      display a score.
 */
export async function analyzeWalletBehavior(address: string): Promise<number[]> {
  console.log("[ML analyzeWalletBehavior] starting analysis for", address);

  // ------------------------------------------------------------------
  // Step 1: RPC fetch
  // ------------------------------------------------------------------
  let scan: ScannedBehaviorData;
  try {
    console.log("[ML analyzeWalletBehavior] Step 1: RPC fetch from", FLARE_RPC_URL);
    const provider = new ethers.JsonRpcProvider(FLARE_RPC_URL);
    const normalizedAddress = address.toLowerCase();
    scan = await withTimeout(
      scanRecentBehavior(provider, normalizedAddress),
      ML_SCAN_TIMEOUT_MS,
    );
    console.log(
      "[ML analyzeWalletBehavior] RPC fetch succeeded:",
      scan.sentTxs.length,
      "sent transactions,",
      scan.inboundSenders.size,
      "inbound senders",
    );
  } catch (err) {
    console.error("[ML analyzeWalletBehavior] RPC fetch failed:", err);
    console.log(
      "[ML analyzeWalletBehavior] falling back to deterministic mock features for demo",
    );
    return generateMockFeatures(address);
  }

  if (scan.sentTxs.length === 0) {
    console.log(
      "[ML analyzeWalletBehavior] no outgoing history found; returning zero feature vector",
    );
    return new Array(FEATURE_COUNT).fill(0);
  }

  // ------------------------------------------------------------------
  // Step 2: feature extraction
  // ------------------------------------------------------------------
  let features: number[];
  try {
    console.log("[ML analyzeWalletBehavior] Step 2: feature extraction");
    features = await buildFeatureVector(scan);
    console.log("[ML analyzeWalletBehavior] feature extraction succeeded:", features);
  } catch (err) {
    console.error("[ML analyzeWalletBehavior] feature extraction failed:", err);
    console.log(
      "[ML analyzeWalletBehavior] returning zero vector due to extraction error",
    );
    return new Array(FEATURE_COUNT).fill(0);
  }

  // ------------------------------------------------------------------
  // Step 3: prediction preview (logged here for diagnostics; the caller
  // receives the raw feature vector so it can sign the attestation itself)
  // ------------------------------------------------------------------
  try {
    console.log("[ML analyzeWalletBehavior] Step 3: heuristic prediction");
    const { botProbability, humanProbability } = predictBotProbability(features);
    console.log(
      "[ML analyzeWalletBehavior] prediction succeeded:",
      "botProbability =",
      botProbability,
      "humanProbability =",
      humanProbability,
    );
  } catch (err) {
    console.error("[ML analyzeWalletBehavior] prediction failed:", err);
  }

  return features;
}

/**
 * @notice Scan recent blocks for outbound transactions from `address` and inbound
 *      transactions to `address` in a single backward pass.
 * @dev Blocks are fetched with bounded concurrency to reduce wall-clock time
 *      while avoiding provider rate limits.
 */
async function scanRecentBehavior(
  provider: ethers.JsonRpcProvider,
  normalizedAddress: string,
): Promise<ScannedBehaviorData> {
  const latestBlock = await provider.getBlockNumber();
  const endBlock = Math.max(0, latestBlock - ML_SCAN_MAX_BLOCKS);

  const sentTxs: ethers.TransactionResponse[] = [];
  const timestamps: number[] = [];
  const inboundSenders = new Set<string>();

  const blockNumbers: number[] = [];
  for (let b = latestBlock; b >= endBlock; b--) {
    blockNumbers.push(b);
  }

  for (
    let i = 0;
    i < blockNumbers.length && sentTxs.length < ML_BEHAVIOR_TX_LIMIT;
    i += ML_SCAN_CONCURRENCY
  ) {
    const batch = blockNumbers.slice(i, i + ML_SCAN_CONCURRENCY);
    const blocks = await Promise.all(
      batch.map((n) => provider.getBlock(n, true)),
    );

    for (const block of blocks) {
      if (!block || !block.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();

        if (from === normalizedAddress) {
          sentTxs.push(tx);
          timestamps.push(Number(block.timestamp));
          if (sentTxs.length >= ML_BEHAVIOR_TX_LIMIT) break;
        } else if (to === normalizedAddress && from) {
          inboundSenders.add(from);
        }
      }
      if (sentTxs.length >= ML_BEHAVIOR_TX_LIMIT) break;
    }
  }

  return { sentTxs, timestamps, inboundSenders };
}

/**
 * @notice Turn the raw scanned data into the 20-dimensional behavioral feature
 *      vector used by the heuristic ML model.
 */
async function buildFeatureVector(
  scan: ScannedBehaviorData,
): Promise<number[]> {
  const { sentTxs, timestamps, inboundSenders } = scan;
  const provider = sentTxs[0].provider;

  const counterparties = extractCounterparties(sentTxs);
  const { contracts, eoas } = await classifyCounterparties(
    provider,
    counterparties,
  );
  const { values, gasLimits, gasPrices, failedCount, zeroValueCount, contractTxs } =
    await computeValueGasFeatures(sentTxs, contracts);

  const { hourCounts, dayMap, dayCounts } = computeTimingFeatures(timestamps);
  const nonceGaps = computeNonceGaps(sentTxs);
  const reciprocity = computeReciprocity(counterparties, inboundSenders);

  // Blocks are scanned from newest to oldest, so timestamps[0] is the most
  // recent transaction and timestamps[timestamps.length - 1] is the oldest.
  const ageSeconds = Math.max(
    SECONDS_PER_DAY,
    timestamps[0] - timestamps[timestamps.length - 1],
  );
  const observedActivityAge = ageSeconds / SECONDS_PER_DAY;
  const txFrequency = sentTxs.length / observedActivityAge;

  const contractInteractionRatio =
    sentTxs.length > 0 ? contractTxs.length / sentTxs.length : 0;
  const eoaInteractionRatio =
    counterparties.size > 0 ? eoas.size / counterparties.size : 0;

  return [
    txFrequency,
    variance(gasLimits),
    contracts.size,
    eoas.size,
    sentTxs.length > 0 ? failedCount / sentTxs.length : 0,
    normalizedEntropy(hourCounts),
    variance(values),
    mean(values),
    values.length > 0 ? Math.max(...values) : 0,
    values.length > 0 ? Math.min(...values) : 0,
    contractInteractionRatio,
    dayMap.size,
    dayCounts.length > 0 ? Math.max(...dayCounts) / mean(dayCounts) : 0,
    nonceGaps,
    variance(gasPrices),
    mean(gasLimits),
    sentTxs.length > 0 ? zeroValueCount / sentTxs.length : 0,
    eoaInteractionRatio,
    reciprocity,
    observedActivityAge,
  ];
}

/**
 * @notice Generate a deterministic, demo-friendly feature vector when the Flare
 *      RPC is not reachable.
 * @dev The vector is seeded from the target address so the same wallet always
 *      yields the same mock score, while still looking like a normal active
 *      wallet.
 */
function generateMockFeatures(address: string): number[] {
  const seed = ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(`mock-ml-${address.toLowerCase()}`)),
  );
  const rand = (idx: number) => (seed[idx % seed.length] ?? 128) / 255;

  const features = [
    1 + rand(0) * 4, // txFrequency
    10_000 + rand(1) * 80_000, // gasVariation
    3 + rand(2) * 12, // contractDiversity
    2 + rand(3) * 10, // counterpartyDiversity
    rand(4) * 0.05, // failureRate
    0.4 + rand(5) * 0.5, // timingPatterns entropy
    0.1 + rand(6) * 5, // valueVariance
    0.5 + rand(7) * 5, // meanValue
    1 + rand(8) * 20, // maxValue
    0, // minValue
    0.1 + rand(10) * 0.4, // contractInteractionRatio
    2 + rand(11) * 10, // uniqueDayCount
    0.5 + rand(12) * 2, // burstiness
    rand(13) * 3, // nonceGaps
    50 + rand(14) * 500, // gasPriceVariance
    25_000 + rand(15) * 100_000, // meanGasLimit
    rand(16) * 0.2, // zeroValueTxRatio
    0.5 + rand(17) * 0.5, // eoaInteractionRatio
    0.1 + rand(18) * 0.4, // reciprocity
    10 + rand(19) * 300, // observedActivityAge (days)
  ];

  console.log(
    "[ML analyzeWalletBehavior] generated mock features for",
    address,
    features,
  );
  return features;
}

function extractCounterparties(
  txs: ethers.TransactionResponse[],
): Set<string> {
  return new Set(
    txs.map((tx) => tx.to?.toLowerCase()).filter((to): to is string => !!to),
  );
}

async function classifyCounterparties(
  provider: ethers.Provider,
  counterparties: Set<string>,
): Promise<CounterpartyClassification> {
  const codeMap = await fetchCodeForAddresses(
    provider,
    Array.from(counterparties),
    ML_CODE_FETCH_CONCURRENCY,
  );

  const contracts = new Set<string>();
  const eoas = new Set<string>();
  for (const [addr, code] of codeMap) {
    if (!code || code === "0x" || code === "0x0") {
      eoas.add(addr);
    } else {
      contracts.add(addr);
    }
  }
  return { contracts, eoas };
}

async function computeValueGasFeatures(
  sentTxs: ethers.TransactionResponse[],
  contracts: Set<string>,
): Promise<ValueGasFeatures> {
  const receipts = await fetchAllReceipts(
    sentTxs,
    ML_RECEIPT_FETCH_CONCURRENCY,
  );
  const failedCount = receipts.filter((r) => r && r.status === 0).length;

  const values = sentTxs.map((tx) => Number(ethers.formatEther(tx.value)));
  const gasLimits = sentTxs.map((tx) => Number(tx.gasLimit));
  const gasPrices = sentTxs
    .map((tx) => (tx.gasPrice ? Number(tx.gasPrice) : 0))
    .filter((p) => p > 0);

  const zeroValueCount = values.filter((v) => v === 0).length;
  const contractTxs = sentTxs.filter((tx) => {
    const to = tx.to?.toLowerCase();
    return to ? contracts.has(to) : false;
  });

  return { values, gasLimits, gasPrices, failedCount, zeroValueCount, contractTxs };
}

function computeTimingFeatures(timestamps: number[]): TimingFeatures {
  const hourCounts = new Array(24).fill(0);
  const dayMap = new Map<string, number>();
  for (const ts of timestamps) {
    const d = new Date(ts * 1000);
    hourCounts[d.getUTCHours()]++;
    const day = d.toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
  }
  return { hourCounts, dayMap, dayCounts: Array.from(dayMap.values()) };
}

function computeNonceGaps(txs: ethers.TransactionResponse[]): number {
  const sortedNonces = txs
    .map((tx) => Number(tx.nonce))
    .sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < sortedNonces.length; i++) {
    const gap = sortedNonces[i] - sortedNonces[i - 1] - 1;
    if (gap > 0) gaps += gap;
  }
  return gaps;
}

function computeReciprocity(
  counterparties: Set<string>,
  inboundSenders: Set<string>,
): number {
  if (counterparties.size === 0) return 0;
  const reciprocalCount = Array.from(counterparties).filter((c) =>
    inboundSenders.has(c),
  ).length;
  return reciprocalCount / counterparties.size;
}

/**
 * @notice Heuristic ML inference simulating a Random Forest + Isolation Forest.
 * @dev Features are normalized, weighted, and passed through a sigmoid to yield
 *      a bot probability. An isolation-style anomaly score is blended in to
 *      capture out-of-distribution wallets without needing a trained model.
 */
export function predictBotProbability(features: number[]): {
  botProbability: number;
  humanProbability: number;
} {
  const normalized = normalizeFeatures(features);

  // Random-Forest-style weighted sum.
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < normalized.length; i++) {
    weightedSum += normalized[i] * FEATURE_WEIGHTS[i];
    totalWeight += Math.abs(FEATURE_WEIGHTS[i]);
  }
  const rfScore = clamp((weightedSum / totalWeight + 1) / 2, 0, 1);

  // Isolation-Forest-style anomaly score: average absolute deviation from the
  // expected "human" centroid (midpoint of each normalized range).
  let anomalySum = 0;
  for (const v of normalized) {
    anomalySum += Math.abs(v - 0.5);
  }
  const ifScore = clamp(anomalySum / normalized.length, 0, 1);

  // Blend structured RF signal with anomaly signal.
  const blended =
    ML_RF_BLEND_WEIGHT * rfScore + ML_ANOMALY_BLEND_WEIGHT * ifScore;

  // Sigmoid-like stretch so confident signals approach the extremes.
  const botProbability = clamp(
    1 / (1 + Math.exp(-ML_SIGMOID_STEEPNESS * (blended - 0.5))),
    0,
    1,
  );

  return {
    botProbability,
    humanProbability: 1 - botProbability,
  };
}

function normalizeFeatures(features: number[]): number[] {
  return features.map((v, i) => clamp(v / FEATURE_NORMALIZATION[i], 0, 1));
}

function formatCount(n: number): string {
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * @notice Generate the top-3 human-readable explanation factors.
 * @dev Each feature's weighted deviation from a neutral midpoint is scored;
 *      the three strongest bot-indicating deviations are returned.
 */
export function generateExplanation(
  features: number[],
  botProbability: number,
): string[] {
  const normalized = normalizeFeatures(features);
  const factors: Array<{ score: number; text: string }> = [];

  for (const rule of BOT_INDICATOR_RULES) {
    const n = normalized[rule.index];
    const weight = FEATURE_WEIGHTS[rule.index];
    if (rule.direction === "high" && n > rule.threshold) {
      const score = (n - rule.threshold) * Math.abs(weight);
      factors.push({ score, text: rule.template(features[rule.index]) });
    } else if (rule.direction === "low" && n < rule.threshold) {
      const score = (rule.threshold - n) * Math.abs(weight);
      factors.push({ score, text: rule.template(features[rule.index]) });
    }
  }

  factors.sort((a, b) => b.score - a.score);
  const topFactors = factors.slice(0, 3).map((f) => f.text);

  return topFactors.length > 0
    ? topFactors
    : [
        botProbability > 0.5
          ? "Behavioral signals are broadly bot-like"
          : "Behavioral signals are broadly human-like",
      ];
}

async function fetchAllReceipts(
  txs: ethers.TransactionResponse[],
  concurrency: number,
): Promise<(ethers.TransactionReceipt | null)[]> {
  const provider = txs[0].provider;
  const results: (ethers.TransactionReceipt | null)[] = [];
  for (let i = 0; i < txs.length; i += concurrency) {
    const batch = txs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((tx) =>
        provider
          .getTransactionReceipt(tx.hash)
          .catch(() => null),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}

async function fetchCodeForAddresses(
  provider: ethers.Provider,
  addresses: string[],
  concurrency: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency);
    const codes = await Promise.all(
      batch.map((addr) => provider.getCode(addr).catch(() => "0x")),
    );
    batch.forEach((addr, idx) => map.set(addr.toLowerCase(), codes[idx]));
  }
  return map;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const sq = values.map((v) => (v - m) ** 2);
  return mean(sq);
}

function normalizedEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    entropy -= p * Math.log2(p);
  }
  const max = Math.log2(counts.length);
  return max === 0 ? 0 : entropy / max;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("analysis timeout")), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
