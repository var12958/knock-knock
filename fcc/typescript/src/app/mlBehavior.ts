/**
 * @notice ML-powered on-chain behavioral Sybil-detection using a trained
 *      Random Forest exported from `ml/train_model.py`.
 * @dev This module loads `model_weights.json`, extracts the exact 10 features
 *      the forest was trained on, walks every decision tree using the live
 *      Flare RPC values, and returns a calibrated bot probability plus a top-3
 *      explanation driven by the model's real feature importances.
 */

import { ethers } from "ethers";
import {
  ML_BEHAVIOR_TX_LIMIT,
  ML_SCAN_MAX_BLOCKS,
  ML_SCAN_TIMEOUT_MS,
  ML_SCAN_CONCURRENCY,
  ML_SIGMOID_STEEPNESS,
  FLARE_RPC_URL,
} from "./config.js";
import rawModelWeights from "./model_weights.json" with { type: "json" };

/** One decision-tree node as serialized by scikit-learn. */
interface ModelNode {
  feature_index: number;
  feature_name: string | null;
  threshold: number;
  left_child: number | null;
  right_child: number | null;
  is_leaf: boolean;
  samples: number;
  impurity: number;
  value: number[];
}

/** One estimator in the Random Forest. */
interface ModelTree {
  node_count: number;
  nodes: ModelNode[];
}

/** Top-level artifact produced by `ml/train_model.py`. */
interface ModelWeights {
  schema_version: string;
  feature_names: string[];
  feature_importances: number[];
  accuracy: number;
  test_samples: number;
  train_samples: number;
  target_distribution: Record<string, number>;
  class_labels: Record<string, string>;
  provenance?: Record<string, unknown>;
  trees: ModelTree[];
}

const MODEL = validateModelWeights(rawModelWeights as ModelWeights);

/** Number of features the trained forest expects. */
const FEATURE_COUNT = MODEL.feature_names.length;

interface ScannedBehaviorData {
  sentTxs: ethers.TransactionResponse[];
  receivedTxs: ethers.TransactionResponse[];
  allTimestamps: number[];
}

/**
 * @notice Runtime guard that the loaded artifact is structurally sound and
 *      aligned with this module's expectations.
 */
function validateModelWeights(weights: ModelWeights): ModelWeights {
  if (!weights || typeof weights !== "object") {
    throw new Error("Model weights artifact is not an object");
  }
  if (!Array.isArray(weights.feature_names) || weights.feature_names.length === 0) {
    throw new Error("Model weights missing feature_names array");
  }
  if (!Array.isArray(weights.feature_importances)) {
    throw new Error("Model weights missing feature_importances array");
  }
  if (weights.feature_names.length !== weights.feature_importances.length) {
    throw new Error(
      `Feature names (${weights.feature_names.length}) and importances (${weights.feature_importances.length}) length mismatch`,
    );
  }
  if (!Array.isArray(weights.trees) || weights.trees.length === 0) {
    throw new Error("Model weights missing trees array");
  }
  for (const tree of weights.trees) {
    if (!tree || typeof tree !== "object" || !Array.isArray(tree.nodes)) {
      throw new Error("Invalid tree structure in model weights");
    }
    if (tree.nodes.length === 0) {
      throw new Error("Empty tree in model weights");
    }
  }
  return weights;
}

/**
 * @notice Fetch the wallet's recent on-chain history and compute the 10 features
 *      the trained Random Forest expects.
 * @dev Scans blocks backwards from the Flare RPC until it collects
 *      `ML_BEHAVIOR_TX_LIMIT` outgoing transactions or hits the configured
 *      block-age cap. The same pass also collects inbound transactions (with
 *      timestamps) so the model's count/ratio/timing features match the
 *      training distribution as closely as possible.
 *
 *      All RPC work is bounded by a hard timeout. If the RPC fetch fails the
 *      call throws so the handler can decide whether to fail closed or fall
 *      back to mock features (controlled by `ML_MOCK_ON_FAILURE` in config).
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
      scan.receivedTxs.length,
      "received transactions",
    );
  } catch (err) {
    console.error("[ML analyzeWalletBehavior] RPC fetch failed:", err);
    throw err;
  }

  if (scan.sentTxs.length === 0 && scan.receivedTxs.length === 0) {
    console.log(
      "[ML analyzeWalletBehavior] no on-chain history found; returning zero feature vector",
    );
    return new Array(FEATURE_COUNT).fill(0);
  }

  // ------------------------------------------------------------------
  // Step 2: feature extraction
  // ------------------------------------------------------------------
  let features: number[];
  try {
    console.log("[ML analyzeWalletBehavior] Step 2: feature extraction");
    features = buildFeatureVector(scan);
    console.log("[ML analyzeWalletBehavior] feature extraction succeeded:", features);
    console.log(
      "[ML analyzeWalletBehavior] feature order:",
      MODEL.feature_names.join(", "),
    );
  } catch (err) {
    console.error("[ML analyzeWalletBehavior] feature extraction failed:", err);
    console.log(
      "[ML analyzeWalletBehavior] returning zero vector due to extraction error",
    );
    return new Array(FEATURE_COUNT).fill(0);
  }

  // ------------------------------------------------------------------
  // Step 3: prediction preview (logged here for diagnostics)
  // ------------------------------------------------------------------
  try {
    console.log("[ML analyzeWalletBehavior] Step 3: Random Forest prediction");
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
 *      while avoiding provider rate limits. Transaction timestamps are taken
 *      from the block timestamp because the Flare RPC `getBlock` path only
 *      exposes block-level timestamps.
 */
async function scanRecentBehavior(
  provider: ethers.JsonRpcProvider,
  normalizedAddress: string,
): Promise<ScannedBehaviorData> {
  const latestBlock = await provider.getBlockNumber();
  const endBlock = Math.max(0, latestBlock - ML_SCAN_MAX_BLOCKS);

  const sentTxs: ethers.TransactionResponse[] = [];
  const receivedTxs: ethers.TransactionResponse[] = [];
  const allTimestamps: number[] = [];

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
      const timestamp = Number(block.timestamp);

      for (const tx of block.prefetchedTransactions) {
        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();

        if (from === normalizedAddress) {
          sentTxs.push(tx);
          allTimestamps.push(timestamp);
          if (sentTxs.length >= ML_BEHAVIOR_TX_LIMIT) break;
        } else if (to === normalizedAddress && from) {
          receivedTxs.push(tx);
          allTimestamps.push(timestamp);
        }
      }
      if (sentTxs.length >= ML_BEHAVIOR_TX_LIMIT) break;
    }
  }

  return { sentTxs, receivedTxs, allTimestamps };
}

/**
 * @notice Turn the raw scanned data into the 10-dimensional feature vector
 *      required by the trained Random Forest.
 * @dev Feature names and order are taken directly from `model_weights.json`.
 *      Values are kept in the same units as the training data (gas in gas units,
 *      gas price in wei, value in ether, timestamps in seconds).
 *
 *      NOTE: `countTx` and the timestamp features are derived from the bounded
 *      scan window (`ML_SCAN_MAX_BLOCKS` / `ML_BEHAVIOR_TX_LIMIT`). They may not
 *      match the full-wallet distributions the synthetic model was trained on,
 *      so the live score should be interpreted as a windowed behavioral signal
 *      rather than a globally calibrated probability.
 */
function buildFeatureVector(scan: ScannedBehaviorData): number[] {
  const { sentTxs, receivedTxs, allTimestamps } = scan;

  const outgoingCount = sentTxs.length;
  const incomingCount = receivedTxs.length;
  const countTx = outgoingCount + incomingCount;
  const outgoingRatio = countTx > 0 ? outgoingCount / countTx : 0;

  const values = sentTxs.map((tx) => Number(ethers.formatEther(tx.value)));
  const gasLimits = sentTxs.map((tx) => Number(tx.gasLimit));
  const gasPrices = sentTxs
    .map((tx) => {
      // EIP-1559 transactions expose maxFeePerGas; legacy transactions expose
      // gasPrice. Fall back to the effective gas price when available.
      const price = tx.maxFeePerGas ?? tx.gasPrice;
      return price ? Number(price) : 0;
    })
    .filter((p) => p > 0);

  const interactedAddresses = new Set<string>();
  for (const tx of sentTxs) {
    if (tx.to) interactedAddresses.add(tx.to.toLowerCase());
  }
  for (const tx of receivedTxs) {
    if (tx.from) interactedAddresses.add(tx.from.toLowerCase());
  }
  const countUniqueInteracted = interactedAddresses.size;

  const featureByName = new Map<string, number>([
    ["gas__maximum", gasLimits.length > 0 ? Math.max(...gasLimits) : 0],
    ["gasPrice__mean", mean(gasPrices)],
    ["timeStamp__standard_deviation", standardDeviation(allTimestamps)],
    ["outgoingRatio", outgoingRatio],
    ["countUniqueInteracted", countUniqueInteracted],
    ["gas__mean", mean(gasLimits)],
    ["timeStamp__mean_abs_change", meanAbsoluteChange(allTimestamps)],
    ["value__maximum", values.length > 0 ? Math.max(...values) : 0],
    ["value__mean", mean(values)],
    ["countTx", countTx],
  ]);

  return MODEL.feature_names.map((name) => {
    const value = featureByName.get(name);
    if (value === undefined) {
      console.warn(`[ML buildFeatureVector] unknown feature name: ${name}`);
      return 0;
    }
    return Number.isFinite(value) ? value : 0;
  });
}

/**
 * @notice Generate a deterministic, demo-friendly feature vector when the Flare
 *      RPC is not reachable.
 * @dev The vector is seeded from the target address so the same wallet always
 *      yields the same mock score. Values are drawn from distributions that
 *      roughly match the training data so the forest returns a plausible
 *      probability.
 */
export function generateMockFeatures(address: string): number[] {
  const seed = ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(`mock-ml-${address.toLowerCase()}`)),
  );
  const rand = (idx: number) => (seed[idx % seed.length] ?? 128) / 255;
  const lognormal = (idx: number, mu: number, sigma: number) =>
    Math.exp(mu + sigma * (rand(idx) * 2 - 1));

  const featureByName = new Map<string, number>([
    ["gas__maximum", lognormal(0, 11.0, 0.8)],
    ["gasPrice__mean", lognormal(1, 23.0, 1.5)],
    ["timeStamp__standard_deviation", lognormal(2, 8.0, 1.0)],
    ["outgoingRatio", 0.5 + rand(3) * 0.4],
    ["countUniqueInteracted", Math.floor(5 + rand(4) * 55)],
    ["gas__mean", lognormal(5, 10.8, 0.8)],
    ["timeStamp__mean_abs_change", lognormal(6, 7.5, 1.0)],
    ["value__maximum", lognormal(7, -2.0, 1.0)],
    ["value__mean", lognormal(8, -5.0, 1.0)],
    ["countTx", Math.floor(10 + rand(9) * 490)],
  ]);

  const features = MODEL.feature_names.map((name) => {
    const value = featureByName.get(name);
    return value !== undefined && Number.isFinite(value) ? value : 0;
  });

  console.log(
    "[ML analyzeWalletBehavior] generated mock features for",
    address,
    features,
  );
  return features;
}

/**
 * @notice Walk a single decision tree and return the bot-class proportion.
 * @dev Internal nodes compare `features[feature_index]` against the trained
 *      threshold: values <= threshold go left, values > threshold go right.
 *      Leaf `value` arrays are ordered [human, bot] per the model's
 *      `class_labels`, so the returned proportion is bot / (human + bot).
 */
function predictTree(tree: ModelTree, features: number[]): number {
  let nodeId = 0;
  while (true) {
    const node = tree.nodes[nodeId];
    if (!node) {
      throw new Error(`Tree node ${nodeId} is missing`);
    }
    if (node.is_leaf) {
      const human = node.value[0] ?? 0;
      const bot = node.value[1] ?? 0;
      const total = human + bot;
      return total > 0 ? bot / total : 0;
    }

    const featureValue = features[node.feature_index] ?? 0;
    const nextNodeId =
      featureValue <= node.threshold ? node.left_child : node.right_child;
    if (nextNodeId === null || nextNodeId === undefined) {
      throw new Error(
        `Tree node ${nodeId} has missing child for feature ${node.feature_name} (index ${node.feature_index})`,
      );
    }
    nodeId = nextNodeId;
  }
}

/**
 * @notice Trained Random Forest inference.
 * @dev The feature vector must already be aligned with `MODEL.feature_names`.
 *      Each tree contributes a bot probability; the forest prediction is the
 *      mean across all trees. A final sigmoid stretch maps the raw score to a
 *      calibrated probability while preserving the 0–1 range.
 */
export function predictBotProbability(features: number[]): {
  botProbability: number;
  humanProbability: number;
} {
  if (!Array.isArray(features)) {
    throw new Error("predictBotProbability requires a feature array");
  }
  if (features.length !== FEATURE_COUNT) {
    throw new Error(
      `Feature vector length ${features.length} does not match model feature count ${FEATURE_COUNT}`,
    );
  }

  const treePredictions = MODEL.trees.map((tree) => predictTree(tree, features));
  const rawBotProbability = mean(treePredictions);

  // Calibrate with the same sigmoid parameters used by the heuristic model so
  // that confident forest scores approach the extremes smoothly.
  const botProbability = clamp(
    1 / (1 + Math.exp(-ML_SIGMOID_STEEPNESS * (rawBotProbability - 0.5))),
    0,
    1,
  );

  return {
    botProbability,
    humanProbability: 1 - botProbability,
  };
}

/**
 * @notice Generate the top-3 human-readable explanation factors.
 * @dev Each line uses the actual feature name and importance from the trained
 *      model artifact, sorted by importance descending. This makes the
 *      explanation faithful to what the Random Forest actually learned.
 */
export function generateExplanation(
  features: number[],
  botProbability: number,
): string[] {
  if (!Array.isArray(features) || features.length !== FEATURE_COUNT) {
    console.warn(
      `[ML generateExplanation] feature vector length mismatch: ${features?.length} vs ${FEATURE_COUNT}`,
    );
  }

  const factors = MODEL.feature_names
    .map((name, index) => ({
      name,
      importance: MODEL.feature_importances[index] ?? 0,
      value: features[index] ?? 0,
    }))
    .filter((f) => Number.isFinite(f.importance) && f.importance > 0)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3)
    .map(
      (f) => `Feature: ${f.name} (Importance: ${f.importance.toFixed(3)})`,
    );

  if (factors.length > 0) {
    return factors;
  }

  return [
    botProbability > 0.5
      ? "Behavioral signals are broadly bot-like"
      : "Behavioral signals are broadly human-like",
  ];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const squaredDiffs = values.map((v) => (v - m) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

function meanAbsoluteChange(values: number[]): number {
  if (values.length <= 1) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let totalChange = 0;
  for (let i = 1; i < sorted.length; i++) {
    totalChange += Math.abs(sorted[i] - sorted[i - 1]);
  }
  return totalChange / (sorted.length - 1);
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
