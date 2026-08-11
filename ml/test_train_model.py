"""Unit tests for ml/train_model.py."""

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

import train_model as tm


@pytest.fixture
def sample_features() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "address": [f"0x{i:040x}" for i in range(10)],
            "gas__maximum": np.random.rand(10),
            "gasPrice__mean": np.random.rand(10),
            "timeStamp__standard_deviation": np.random.rand(10),
            "outgoingRatio": np.random.rand(10),
            "countUniqueInteracted": np.random.randint(1, 100, 10),
        }
    )


@pytest.fixture
def sample_labels() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "fromAddress": [f"0x{i:040x}" for i in range(10)],
            "label_annotatorA": [
                "human",
                "mev",
                "human",
                "cex",
                "human",
                "trader",
                "human",
                "nft",
                "human",
                "copytrader",
            ],
        }
    )


def test_build_binary_target_human_is_zero() -> None:
    labels = pd.Series(["human", "Human", "HUMAN"])
    target = tm.build_binary_target(labels)
    assert target.tolist() == [0, 0, 0]


def test_build_binary_target_bot_is_one() -> None:
    labels = pd.Series(["mev", "cex", "copytrader", "general"])
    target = tm.build_binary_target(labels)
    assert target.tolist() == [1, 1, 1, 1]


def test_build_binary_target_drops_missing() -> None:
    labels = pd.Series(["human", np.nan, None, "mev", ""])
    target = tm.build_binary_target(labels)
    assert target[0] == 0
    assert target[3] == 1
    assert target[[1, 2, 4]].isna().all()


def test_prepare_data_matches_addresses_and_builds_target(
    sample_features: pd.DataFrame, sample_labels: pd.DataFrame
) -> None:
    X, y = tm.prepare_data(sample_features, sample_labels)
    assert len(X) == 10
    assert len(y) == 10
    assert y.value_counts().to_dict() == {0: 5, 1: 5}


def test_prepare_data_normalizes_address_case(sample_features: pd.DataFrame) -> None:
    labels = pd.DataFrame(
        {
            "fromAddress": [addr.upper() for addr in sample_features["address"]],
            "label_annotatorA": ["human"] * 5 + ["mev"] * 5,
        }
    )
    X, y = tm.prepare_data(sample_features, labels)
    assert len(X) == 10


def test_prepare_data_raises_on_single_class(sample_features: pd.DataFrame) -> None:
    labels = pd.DataFrame(
        {
            "fromAddress": sample_features["address"],
            "label_annotatorA": ["human"] * 10,
        }
    )
    with pytest.raises(ValueError, match="Need both human and bot labels"):
        tm.prepare_data(sample_features, labels)


def test_prepare_data_raises_on_no_matching_addresses(
    sample_features: pd.DataFrame,
) -> None:
    labels = pd.DataFrame(
        {
            "fromAddress": [f"0xdeadbeef{i:032x}" for i in range(10)],
            "label_annotatorA": ["mev"] * 10,
        }
    )
    with pytest.raises(ValueError, match="No matching addresses"):
        tm.prepare_data(sample_features, labels)


def test_select_top_features_runs_on_training_set_only() -> None:
    X_train = pd.DataFrame(
        {
            "a": [1, 2, 3, 4, 5, 6],
            "b": [6, 5, 4, 3, 2, 1],
            "c": [1, 1, 1, 1, 1, 1],
        }
    )
    y_train = pd.Series([0, 0, 1, 1, 0, 1])
    selected, selector = tm.select_top_features(X_train, y_train, k=2)
    assert len(selected) == 2
    assert "c" not in selected
    assert selector.get_support().sum() == 2


def test_generate_synthetic_dataset() -> None:
    X, y = tm.generate_synthetic_dataset(n_samples=200, random_state=1)
    assert len(X) == 200
    assert len(y) == 200
    assert set(X.columns) == set(tm.SYNTHETIC_FEATURES)
    assert y.value_counts().to_dict() == {0: 100, 1: 100}
    assert not X.isna().any().any()


def test_write_model_weights_round_trip(tmp_path: Path) -> None:
    output_path = tmp_path / "model_weights.json"
    model_weights = {
        "schema_version": tm.MODEL_SCHEMA_VERSION,
        "feature_names": ["a", "b"],
        "feature_importances": [0.6, 0.4],
        "accuracy": 0.9,
        "test_samples": 2,
        "train_samples": 8,
        "target_distribution": {0: 5, 1: 5},
        "class_labels": {"0": "human", "1": "bot"},
        "provenance": {"training_source": "real_labels"},
        "trees": [
            {"node_count": 1, "nodes": [{"feature_index": -2, "is_leaf": True, "value": [5, 5]}]}
        ],
    }
    tm.write_model_weights(model_weights, output_path)
    assert output_path.exists()
    reloaded = json.loads(output_path.read_text(encoding="utf-8"))
    assert reloaded["feature_names"] == model_weights["feature_names"]
    assert reloaded["trees"] == model_weights["trees"]


def test_serialize_tree() -> None:
    from sklearn.tree import DecisionTreeClassifier

    X = pd.DataFrame({"a": [1, 2, 3, 4], "b": [4, 3, 2, 1]})
    y = pd.Series([0, 0, 1, 1])
    tree = DecisionTreeClassifier(random_state=1, max_depth=1).fit(X, y)
    serialized = tm.serialize_tree(tree, feature_names=["a", "b"])
    assert serialized["node_count"] == tree.tree_.node_count
    assert "nodes" in serialized
    assert all("is_leaf" in node for node in serialized["nodes"])


def test_load_labels_prefers_csv(tmp_path: Path) -> None:
    labels_csv = tmp_path / "labels.csv"
    labels_xlsx = tmp_path / "labels.xlsx"
    labels_csv.write_text("fromAddress,label_annotatorA\n0xabc,human\n0xdef,mev\n")
    # create an empty xlsx so csv is preferred
    pd.DataFrame().to_excel(labels_xlsx, index=False)

    original_csv = tm.LABELS_CSV_PATH
    original_xlsx = tm.LABELS_XLSX_PATH
    tm.LABELS_CSV_PATH = labels_csv
    tm.LABELS_XLSX_PATH = labels_xlsx
    try:
        df = tm.load_labels()
        assert set(df["label_annotatorA"]) == {"human", "mev"}
    finally:
        tm.LABELS_CSV_PATH = original_csv
        tm.LABELS_XLSX_PATH = original_xlsx


def test_main_synthetic_fallback(tmp_path: Path, monkeypatch: Any) -> None:
    """End-to-end test that triggers the synthetic fallback path."""
    features_path = tmp_path / "features.csv"
    labels_path = tmp_path / "labels.csv"
    output_path = tmp_path / "model_weights.json"

    pd.DataFrame(
        {
            "address": ["0xabc", "0xdef"],
            "gas__maximum": [1.0, 2.0],
            "gasPrice__mean": [1.0, 2.0],
        }
    ).to_csv(features_path, index=False)
    pd.DataFrame(
        {"fromAddress": ["0xabc", "0xdef"], "label_annotatorA": ["human", "human"]}
    ).to_csv(labels_path, index=False)

    monkeypatch.setattr(tm, "FEATURES_PATH", features_path)
    monkeypatch.setattr(tm, "LABELS_CSV_PATH", labels_path)
    monkeypatch.setattr(tm, "LABELS_XLSX_PATH", tmp_path / "labels.xlsx")
    monkeypatch.setattr(tm, "OUTPUT_PATH", output_path)
    monkeypatch.setattr(tm, "SYNTHETIC_N_SAMPLES", 200)
    monkeypatch.setattr(tm, "N_ESTIMATORS", 5)

    tm.main()

    assert output_path.exists()
    artifact = json.loads(output_path.read_text(encoding="utf-8"))
    assert artifact["schema_version"] == tm.MODEL_SCHEMA_VERSION
    assert artifact["provenance"]["synthetic"] is True
    assert artifact["provenance"]["training_source"] == "synthetic_fallback"
    assert len(artifact["feature_names"]) == tm.SELECTED_K
    assert len(artifact["trees"]) == 5


def test_main_real_labels(tmp_path: Path, monkeypatch: Any) -> None:
    """End-to-end test using real labels with both classes."""
    features_path = tmp_path / "features.csv"
    labels_path = tmp_path / "labels.csv"
    output_path = tmp_path / "model_weights.json"

    pd.DataFrame(
        {
            "address": [f"0x{i:040x}" for i in range(20)],
            "gas__maximum": list(range(20)),
            "gasPrice__mean": list(range(20)),
            "timeStamp__standard_deviation": list(range(20)),
            "outgoingRatio": [0.1] * 10 + [0.9] * 10,
            "countUniqueInteracted": list(range(1, 21)),
            "gas__mean": list(range(20)),
            "timeStamp__mean_abs_change": list(range(20)),
            "value__maximum": list(range(20)),
            "value__mean": list(range(20)),
            "countTx": list(range(20)),
        }
    ).to_csv(features_path, index=False)
    pd.DataFrame(
        {
            "fromAddress": [f"0x{i:040x}" for i in range(20)],
            "label_annotatorA": ["human"] * 10 + ["mev"] * 10,
        }
    ).to_csv(labels_path, index=False)

    monkeypatch.setattr(tm, "FEATURES_PATH", features_path)
    monkeypatch.setattr(tm, "LABELS_CSV_PATH", labels_path)
    monkeypatch.setattr(tm, "LABELS_XLSX_PATH", tmp_path / "labels.xlsx")
    monkeypatch.setattr(tm, "OUTPUT_PATH", output_path)
    monkeypatch.setattr(tm, "N_ESTIMATORS", 5)

    tm.main()

    assert output_path.exists()
    artifact = json.loads(output_path.read_text(encoding="utf-8"))
    assert artifact["provenance"]["synthetic"] is False
    assert artifact["provenance"]["training_source"] == "real_labels"
