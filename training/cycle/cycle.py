"""Entry of the training cycle: python training/cycle/cycle.py --config <toml> <command> ...
See training/cycle/README.md."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from zapcycle.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
