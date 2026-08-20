"""Where the activity dataset lives, and how it is read.

The API server and the semantic search pipeline read the same CSV, so the
location is resolved in one place rather than derived independently in each
module.

Resolution happens when the dataset is *loaded*, not when the module is
imported. An import-time snapshot makes ``FAMILY_DATASET_URL`` invisible to
anything that sets it after the import -- a test fixture, a process that
configures its environment in ``main()``, a worker that is forked after
config is read -- and silently falls back to the default instead. Reading the
variable at load time means the environment is always the source of truth.
"""

import os
from pathlib import Path

#: Environment variable naming the dataset location. Accepts a filesystem
#: path or an ``http(s)://`` URL.
DATASET_ENV_VAR = "FAMILY_DATASET_URL"

#: Used when the environment does not name a location. Relative to the
#: repository root so a checkout works without configuration.
DEFAULT_DATASET_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
)

_REMOTE_SCHEMES = ("http://", "https://")


class DatasetUnavailable(RuntimeError):
    """Raised when the activity dataset cannot be located or read."""


def dataset_source():
    """Return the configured dataset location as a string.

    A variable set to blank or whitespace counts as unset. Honouring it
    literally would mean reading a CSV named ``""``, and the resulting error
    points at the file system rather than at the misconfigured variable.
    """
    configured = (os.getenv(DATASET_ENV_VAR) or "").strip()
    return configured or str(DEFAULT_DATASET_PATH)


def is_remote(source):
    """True when ``source`` is fetched over HTTP rather than read from disk."""
    return str(source).startswith(_REMOTE_SCHEMES)


def read_dataset(source=None):
    """Read the dataset into a DataFrame.

    ``source`` defaults to :func:`dataset_source`. Any failure -- missing
    file, unreachable URL, unparseable CSV -- is reported as
    ``DatasetUnavailable`` naming the location that was tried, so a
    misconfiguration is distinguishable from a genuinely broken file.
    """
    import pandas as pd

    if source is None:
        source = dataset_source()

    # Checked before the read so that a missing file reports the path rather
    # than a pandas parser error mentioning it in passing.
    if not is_remote(source) and not Path(source).exists():
        raise DatasetUnavailable(
            f"Activity dataset not found at {source}. "
            f"Set {DATASET_ENV_VAR} to a readable CSV or place the file at that "
            "path. See data/README.md for the expected columns."
        )

    try:
        return pd.read_csv(source)
    except Exception as exc:
        raise DatasetUnavailable(
            f"Could not read the activity dataset at {source}: {exc}"
        ) from exc


__all__ = [
    "DATASET_ENV_VAR",
    "DEFAULT_DATASET_PATH",
    "DatasetUnavailable",
    "dataset_source",
    "is_remote",
    "read_dataset",
]
