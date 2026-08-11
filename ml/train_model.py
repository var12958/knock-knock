#!/usr/bin/env python3
"""Train a RandomForest bot detector on tsfresh Ethereum wallet features.

Loads feature and label data, selects the top 10 most informative features,
trains a RandomForestClassifier, reports accuracy and feature importances,
and exports a JSON artifact containing the feature names, importances, and
the forest's decision rules for consumption by a TypeScript TEE.
"""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_selection import SelectKBest, f_classif
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split


SCRIPT_DIR = Path(__file__).resolve().parent
ML_DIR = SCRIPT_DIR

FEATURES_PATH = ML_DIR / "features_eth_std.csv"
LABELS_CSV_PATH = ML_DIR / "labels.csv"
LABELS_XLSX_PATH = ML_DIR / "labels.xlsx"
OUTPUT_PATH = ML_DIR / "model_weights.json"

RANDOM_STATE = 42
TEST_SIZE = 0.2
SELECTED_K = 10
MIN_SAMPLES_PER_CLASS = 2
MODEL_SCHEMA_VERSION = "1.0.0"

# Tunable forest parameters. Reduce n_estimators/max_depth to shrink the
# exported JSON artifact if the TypeScript TEE needs a smaller payload.
N_ESTIMATORS = 100
MAX_DEPTH = 12

REQUIRED_FEATURE_COL = "address"
REQUIRED_LABEL_COLS = ["fromAddress", "label_annotatorA"]


class InsufficientClassLabelsError(ValueError):
    """Raised when the merged dataset does not contain both human and bot labels."""


# Fallback synthetic dataset used when real labels lack both human and bot classes.
SYNTHETIC_FEATURES = [
    "gas__maximum",
    "gasPrice__mean",
    "timeStamp__standard_deviation",
    "outgoingRatio",
    "countUniqueInteracted",
    "gas__mean",
    "timeStamp__mean_abs_change",
    "value__maximum",
    "value__mean",
    "countTx",
]
SYNTHETIC_N_SAMPLES = 10_000


def generate_synthetic_dataset(
    n_samples: int = SYNTHETIC_N_SAMPLES,
    random_state: int = RANDOM_STATE,
) -> tuple[pd.DataFrame, pd.Series]:
    """Generate a synthetic wallet dataset with distinct human and bot populations.

    Humans: varied timestamps, normal gas, high sleepiness (high timestamp spread).
    Bots: high frequency, low sleepiness (low timestamp spread), exact/repetitive gas.
    """
    rng = np.random.default_rng(random_state)
    n_per_class = n_samples // 2

    human_params = {
        "gas__maximum": {"dist": "lognormal", "mean": 11.5, "sigma": 0.5},
        "gasPrice__mean": {"dist": "lognormal", "mean": 23.0, "sigma": 0.4},
        "timeStamp__standard_deviation": {"dist": "lognormal", "mean": 13.0, "sigma": 0.8},
        "outgoingRatio": {"dist": "beta", "a": 2.0, "b": 2.0},
        "countUniqueInteracted": {"dist": "poisson_plus", "lam": 3, "extra": 1},
        "gas__mean": {"dist": "lognormal", "mean": 11.2, "sigma": 0.5},
        "timeStamp__mean_abs_change": {"dist": "lognormal", "mean": 12.0, "sigma": 1.1},
        "value__maximum": {"dist": "lognormal", "mean": -5.0, "sigma": 2.0},
        "value__mean": {"dist": "lognormal", "mean": -7.0, "sigma": 1.5},
        "countTx": {"dist": "poisson_plus", "lam": 250, "extra": 30, "max": 500},
    }

    bot_params = {
        "gas__maximum": {"dist": "lognormal", "mean": 10.3, "sigma": 0.1},
        "gasPrice__mean": {"dist": "lognormal", "mean": 22.0, "sigma": 0.05},
        "timeStamp__standard_deviation": {"dist": "lognormal", "mean": 7.0, "sigma": 0.3},
        "outgoingRatio": {"dist": "beta", "a": 8.0, "b": 1.0},
        "countUniqueInteracted": {"dist": "poisson_plus", "lam": 5, "extra": 1},
        "gas__mean": {"dist": "lognormal", "mean": 10.3, "sigma": 0.1},
        "timeStamp__mean_abs_change": {"dist": "lognormal", "mean": 8.0, "sigma": 0.3},
        "value__maximum": {"dist": "lognormal", "mean": -3.0, "sigma": 0.5},
        "value__mean": {"dist": "lognormal", "mean": -6.0, "sigma": 0.5},
        "countTx": {"dist": "poisson_plus", "lam": 800, "extra": 100},
    }

    def make_class(params: dict, n: int) -> pd.DataFrame:
        rows: dict[str, np.ndarray] = {}
        for col, spec in params.items():
            dist_name = spec["dist"]
            if dist_name == "lognormal":
                values = rng.lognormal(mean=spec["mean"], sigma=spec["sigma"], size=n)
            elif dist_name == "beta":
                values = rng.beta(a=spec["a"], b=spec["b"], size=n)
            elif dist_name == "poisson_plus":
                values = rng.poisson(lam=spec["lam"], size=n) + spec["extra"]
            else:
                raise ValueError(f"Unknown distribution: {dist_name}")
            max_val = spec.get("max")
            rows[col] = np.clip(values, 0.0, max_val)
        return pd.DataFrame(rows)

    humans = make_class(human_params, n_per_class)
    bots = make_class(bot_params, n_per_class)

    # Vary human transaction pacing: some humans send bursts quickly, others slowly.
    fast_pacer_mask = rng.random(n_per_class) < 0.4
    fast_pacers = rng.lognormal(mean=9.5, sigma=0.9, size=n_per_class)
    slow_pacers = rng.lognormal(mean=12.0, sigma=0.9, size=n_per_class)
    humans["timeStamp__mean_abs_change"] = np.where(
        fast_pacer_mask, fast_pacers, slow_pacers
    )

    X = pd.concat([humans, bots], ignore_index=True)
    y = pd.Series([0] * n_per_class + [1] * n_per_class, dtype=int)
    return X, y


def load_labels() -> pd.DataFrame:
    """Load labels from CSV if present, otherwise from the Excel file."""
    if LABELS_CSV_PATH.exists():
        labels = pd.read_csv(LABELS_CSV_PATH)
    elif LABELS_XLSX_PATH.exists():
        labels = pd.read_excel(LABELS_XLSX_PATH)
    else:
        raise FileNotFoundError(
            f"No labels file found at {LABELS_CSV_PATH} or {LABELS_XLSX_PATH}"
        )

    missing = [col for col in REQUIRED_LABEL_COLS if col not in labels.columns]
    if missing:
        raise ValueError(f"Labels file missing required columns: {missing}")

    return labels


def build_binary_target(labels: pd.Series) -> pd.Series:
    """Return 0 for human and 1 for any non-null bot category."""
    # Check missing values on the original series before converting to string,
    # so NaN/None/pd.NA are treated as missing rather than the literal "nan"/"none".
    stripped = labels.astype(str).str.strip()
    normalized = stripped.str.lower()
    valid = labels.notna() & (stripped != "")

    if not valid.all():
        invalid_count = (~valid).sum()
        print(f"Warning: dropping {invalid_count} row(s) with missing/empty labels")

    target = pd.Series(index=labels.index, dtype="Int64")
    target.loc[valid] = (normalized.loc[valid] != "human").astype(int)
    return target


def prepare_data(features: pd.DataFrame, labels: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Merge features and labels, build target, and drop invalid rows."""
    if REQUIRED_FEATURE_COL not in features.columns:
        raise ValueError(f"Features file missing required column: {REQUIRED_FEATURE_COL}")

    features_clean = features.copy()
    labels_clean = labels.copy()

    features_clean["address"] = features_clean["address"].str.lower()
    labels_clean["fromAddress"] = labels_clean["fromAddress"].str.lower()

    merged = features_clean.merge(
        labels_clean[["fromAddress", "label_annotatorA"]],
        left_on="address",
        right_on="fromAddress",
        how="inner",
    )

    if merged.empty:
        raise ValueError("No matching addresses found between features and labels.")

    merged = merged.copy()
    merged["is_bot"] = build_binary_target(merged["label_annotatorA"])

    rows_before_drop = len(merged)
    merged = merged.dropna(subset=["is_bot"])
    merged["is_bot"] = merged["is_bot"].astype(int)
    rows_after_drop = len(merged)
    if rows_after_drop < rows_before_drop:
        print(f"Dropped {rows_before_drop - rows_after_drop} row(s) with invalid labels")

    y = merged["is_bot"]
    if y.nunique() < 2:
        raise InsufficientClassLabelsError(
            f"Target has only {y.nunique()} class(es). Need both human and bot labels to train."
        )

    id_columns = {"address", "fromAddress", "label_annotatorA", "is_bot"}
    feature_columns = [col for col in merged.columns if col not in id_columns]

    X = merged[feature_columns].select_dtypes(include="number").copy()
    if X.empty:
        raise ValueError("No numeric feature columns available after merging.")

    rows_before_na = len(X)
    X = X.dropna()
    rows_after_na = len(X)
    if rows_after_na < rows_before_na:
        print(
            f"Dropped {rows_before_na - rows_after_na} row(s) with missing numeric feature values"
        )

    y = y.loc[X.index]

    if len(y) == 0:
        raise ValueError("No rows remain after dropping missing feature values.")

    return X, y


def select_top_features(
    X_train: pd.DataFrame, y_train: pd.Series, k: int = SELECTED_K
) -> tuple[list[str], SelectKBest]:
    """Select the k best features using ANOVA F-value on the training set only."""
    selector = SelectKBest(score_func=f_classif, k=k)
    selector.fit(X_train, y_train)
    mask = selector.get_support()
    selected_columns = X_train.columns[mask].tolist()
    return selected_columns, selector


def serialize_tree(tree, feature_names: list[str]) -> dict:
    """Convert a scikit-learn decision tree into a JSON-serializable dict."""
    tree_struct = tree.tree_
    n_nodes = tree_struct.node_count

    nodes = []
    for node_id in range(n_nodes):
        feature_idx = int(tree_struct.feature[node_id])
        left = int(tree_struct.children_left[node_id])
        right = int(tree_struct.children_right[node_id])
        is_leaf = left == right

        node = {
            "feature_index": feature_idx,
            "feature_name": (
                feature_names[feature_idx]
                if 0 <= feature_idx < len(feature_names)
                else None
            ),
            "threshold": float(tree_struct.threshold[node_id]),
            "left_child": left if not is_leaf else None,
            "right_child": right if not is_leaf else None,
            "is_leaf": is_leaf,
            "samples": int(tree_struct.n_node_samples[node_id]),
            "impurity": float(tree_struct.impurity[node_id]),
            "value": tree_struct.value[node_id].flatten().tolist(),
        }
        nodes.append(node)

    return {"node_count": n_nodes, "nodes": nodes}


def write_model_weights(model_weights: dict, output_path: Path) -> None:
    """Write the model artifact to JSON and verify it can be reloaded."""
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(model_weights, f, indent=2)

    # Round-trip verification to catch serialization errors early.
    with output_path.open("r", encoding="utf-8") as f:
        reloaded = json.load(f)

    required_keys = {
        "schema_version",
        "feature_names",
        "feature_importances",
        "accuracy",
        "trees",
    }
    if set(reloaded.keys()) < required_keys:
        raise RuntimeError(
            f"Model weights JSON missing required keys: {required_keys - set(reloaded.keys())}"
        )
    if reloaded["schema_version"] != model_weights["schema_version"]:
        raise RuntimeError("Model weights JSON schema version mismatch after round-trip.")
    if len(reloaded["feature_names"]) != len(reloaded["feature_importances"]):
        raise RuntimeError("Feature names and importances length mismatch after round-trip.")
    if len(reloaded["trees"]) != len(model_weights["trees"]):
        raise RuntimeError("Tree count mismatch after round-trip.")
    for tree in reloaded["trees"]:
        if "node_count" not in tree or "nodes" not in tree:
            raise RuntimeError("Tree structure missing node_count or nodes after round-trip.")


def load_and_prepare_data() -> tuple[pd.DataFrame, pd.Series, dict[str, Any]]:
    """Load real features and labels, falling back to synthetic data if needed.

    Returns the feature matrix X, target vector y, and a provenance dict that
    records whether the synthetic fallback was used and why.
    """
    print("Loading features...")
    features = pd.read_csv(FEATURES_PATH)
    print(f"Features shape: {features.shape}")

    print("Loading labels...")
    labels = load_labels()
    print(f"Labels shape: {labels.shape}")

    provenance: dict[str, Any] = {
        "features_path": str(FEATURES_PATH),
        "labels_path": str(LABELS_CSV_PATH if LABELS_CSV_PATH.exists() else LABELS_XLSX_PATH),
        "training_source": "real_labels",
        "fallback_reason": None,
        "synthetic": False,
        "real_label_count": int(len(labels)),
        "real_feature_count": int(len(features.columns) - 1),  # excluding address
    }

    print("Merging and preparing data...")
    try:
        X, y = prepare_data(features, labels)
    except InsufficientClassLabelsError:
        print("Warning: real labels do not contain both human and bot classes.")
        print("Training on synthetic data...")
        X, y = generate_synthetic_dataset()
        provenance["training_source"] = "synthetic_fallback"
        provenance["fallback_reason"] = (
            "Real labels did not contain both human and bot classes after merging on address."
        )
        provenance["synthetic"] = True
        provenance["synthetic_samples"] = int(len(y))
        provenance["synthetic_note"] = (
            "Accuracy reflects perfectly separable synthetic fallback data; "
            "not indicative of real-world performance."
        )

    return X, y, provenance


def split_and_select_features(
    X: pd.DataFrame, y: pd.Series
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.Series, list[str], SelectKBest]:
    """Split the data and select the top K features from the training set only."""
    print(f"Splitting data (test_size={TEST_SIZE})...")
    stratify = y if y.value_counts().min() >= max(MIN_SAMPLES_PER_CLASS, 2) else None
    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=TEST_SIZE,
        random_state=RANDOM_STATE,
        stratify=stratify,
    )
    print(f"Train samples: {len(y_train)}, Test samples: {len(y_test)}")

    print(f"Selecting top {SELECTED_K} features from training set...")
    selected_features, selector = select_top_features(X_train, y_train, k=SELECTED_K)
    print(f"Selected features: {selected_features}")

    X_train_selected = pd.DataFrame(
        selector.transform(X_train), columns=selected_features, index=X_train.index
    )
    X_test_selected = pd.DataFrame(
        selector.transform(X_test), columns=selected_features, index=X_test.index
    )

    return X_train_selected, X_test_selected, y_train, y_test, selected_features, selector


def train_and_evaluate(
    X_train: pd.DataFrame,
    X_test: pd.DataFrame,
    y_train: pd.Series,
    y_test: pd.Series,
    selected_features: list[str],
) -> tuple[RandomForestClassifier, float]:
    """Train a RandomForest and report test accuracy."""
    print("Training RandomForestClassifier...")
    clf = RandomForestClassifier(
        n_estimators=N_ESTIMATORS,
        max_depth=MAX_DEPTH,
        min_samples_split=20,
        min_samples_leaf=10,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    clf.fit(X_train, y_train)

    y_pred = clf.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    print(f"Test accuracy: {accuracy:.4f}")

    importances = clf.feature_importances_
    print("\nFeature importances:")
    for name, importance in sorted(
        zip(selected_features, importances), key=lambda x: x[1], reverse=True
    ):
        print(f"  {name}: {importance:.6f}")

    return clf, accuracy


def export_model_weights(
    clf: RandomForestClassifier,
    selected_features: list[str],
    accuracy: float,
    y_train: pd.Series,
    y_test: pd.Series,
    provenance: dict[str, Any],
) -> None:
    """Serialize the trained forest and metadata to model_weights.json."""
    print("\nSerializing model rules...")
    trees = [
        serialize_tree(estimator, selected_features) for estimator in clf.estimators_
    ]

    model_weights = {
        "schema_version": MODEL_SCHEMA_VERSION,
        "feature_names": selected_features,
        "feature_importances": clf.feature_importances_.tolist(),
        "accuracy": float(accuracy),
        "test_samples": int(len(y_test)),
        "train_samples": int(len(y_train)),
        "target_distribution": y_test.value_counts().sort_index().to_dict(),
        "class_labels": {"0": "human", "1": "bot"},
        "provenance": provenance,
        "trees": trees,
    }

    print(f"Writing model weights to {OUTPUT_PATH}...")
    write_model_weights(model_weights, OUTPUT_PATH)
    print(f"Done. Exported {len(trees)} trees with {SELECTED_K} features.")


def main() -> None:
    X, y, provenance = load_and_prepare_data()
    print(f"Prepared shape: X={X.shape}, y={y.shape}")
    print(f"Target distribution: {y.value_counts().sort_index().to_dict()}")

    X_train, X_test, y_train, y_test, selected_features, _ = split_and_select_features(X, y)
    clf, accuracy = train_and_evaluate(X_train, X_test, y_train, y_test, selected_features)
    export_model_weights(clf, selected_features, accuracy, y_train, y_test, provenance)


if __name__ == "__main__":
    main()
