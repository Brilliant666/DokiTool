#!/usr/bin/env python3
"""Verify frozen oracle provenance and integrity without PHP or platform access."""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = "665bd55134982b9fe107aa1cd00373ba8da8ff3c"
TREE = "93744d4d718c3299f82640d2888e93252106db70"


def sha(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(directory: pathlib.Path, source_root: pathlib.Path | None = None) -> dict:
    manifest=json.loads((directory/"manifest.json").read_text())
    if manifest.get("format_version")!=1 or manifest.get("baseline_commit")!=BASE or manifest.get("baseline_tree")!=TREE:
        raise ValueError("Approved baseline version mismatch")
    for path,expected in manifest["files"].items():
        if pathlib.PurePosixPath(path).name!=path or sha(directory/path)!=expected:
            raise ValueError("Frozen data integrity mismatch: "+path)
    cases=json.loads((directory/"cases.json").read_text())["cases"]
    ids=[case["id"] for case in cases]
    if len(ids)!=len(set(ids)) or len(cases)!=manifest["case_count"]:
        raise ValueError("Case inventory mismatch")
    counts=dict(collections.Counter(case["operation"] for case in cases))
    if counts!=manifest["operation_counts"]: raise ValueError("Operation inventory mismatch")
    tickets=json.loads((directory/"tickets.json").read_text())["cases"]
    if len(tickets)!=manifest["ticket_case_count"] or len({c['id'] for c in tickets})!=len(tickets): raise ValueError("Ticket inventory mismatch")
    catalog=json.loads((directory/"catalog.json").read_text())
    if catalog["operation"]!="platform_catalog" or len(catalog["expected"]["data"]["platforms"])!=9: raise ValueError("PHP catalog inventory mismatch")
    if sum(name.startswith("design/") for name in ids)!=29: raise ValueError("All 29 approved design fixtures are required")
    for case in cases:
        if "input" not in case or "expected" not in case or not case.get("scenario"):
            raise ValueError("Incomplete input/output provenance: "+case["id"])
        if "now" in case["input"] and case["input"]["now"]!=manifest["fixed_clock"]["unix_seconds"]:
            raise ValueError("Unexpected case clock: "+case["id"])
        if case["operation"]=="validate_envelope" and case["expected"]["valid"]!=case["input"]["must_accept"]:
            raise ValueError("Invalid PHP validation outcome: "+case["id"])
    for entry in manifest["producer_files"]:
        if sha(ROOT/entry["path"])!=entry["sha256"]:
            raise ValueError("Producer changed; review and regenerate explicitly: "+entry["path"])
    if source_root:
        for entry in manifest["source_files"]:
            if sha(source_root/entry["path"])!=entry["sha256"]:
                raise ValueError("Approved PHP source mismatch: "+entry["path"])
    return {"passed":True,"cases":len(cases),"tickets":len(tickets),"catalog":1,"source_files":len(manifest["source_files"]),"source_bytes_checked":source_root is not None,"baseline_commit":BASE}


def main() -> None:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--directory",type=pathlib.Path,default=ROOT/"backend/testdata/php-baseline")
    ap.add_argument("--source-root",type=pathlib.Path,help="Optional approved PHP archive/current unchanged PHP checkout")
    args=ap.parse_args()
    print(json.dumps(verify(args.directory,args.source_root),sort_keys=True))


if __name__=="__main__": main()
