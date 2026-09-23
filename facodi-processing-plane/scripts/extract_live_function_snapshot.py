#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys


def target_path(repo_root: Path, artifact_name: str) -> Path:
    artifact = Path(artifact_name)
    parts = artifact.parts
    if parts and parts[0] == "functions":
        return repo_root / "supabase" / artifact
    return repo_root / "supabase" / "functions" / artifact


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: extract_live_function_snapshot.py SNAPSHOT_JSON", file=sys.stderr)
        return 64

    snapshot_path = Path(sys.argv[1]).resolve()
    repo_root = Path(__file__).resolve().parents[1]
    with snapshot_path.open() as handle:
        payload = json.load(handle)

    for file_record in payload.get("files", []):
        name = file_record["name"]
        content = file_record["content"]
        destination = target_path(repo_root, name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)
        print(destination.relative_to(repo_root))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
