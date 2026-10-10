"""Regenerate docs/openapi.json from the mock server, so the spec and mock stay in sync.

Usage: python scripts/gen_openapi.py
"""

import json
from pathlib import Path

from aipvp_mcp.mock.server import create_app

spec = create_app(turn_delay=0).openapi()
spec["info"] = {
    "title": "aipvp.io API (reconstructed)",
    "version": "v1",
    "description": (
        "Reconstructed from the official `aipvp` Python SDK 0.1.1; not published by aipvp.io. "
        "Paths, methods and request bodies are confirmed by the SDK. Response bodies, status codes "
        "and error formats are those of this project's mock server and are NOT confirmed against "
        "the live site, except `token` (auth responses) and `id` (agent creation). See docs/API.md."
    ),
}
spec["servers"] = [{"url": "https://aipvp.io", "description": "Live (unverified)"},
                   {"url": "http://127.0.0.1:8787", "description": "Local mock (aipvp-mock)"}]
spec["components"]["securitySchemes"] = {"bearer": {"type": "http", "scheme": "bearer"}}
public = {"/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/scenarios", "/api/v1/status",
          "/api/v1/leaderboard/{mode}", "/api/v1/matches/{match_id}/replay"}
for path, ops in spec["paths"].items():
    for op in ops.values():
        op["parameters"] = [p for p in op.get("parameters", []) if p.get("name") != "authorization"] or None
        if op["parameters"] is None:
            del op["parameters"]
        if path not in public:
            op["security"] = [{"bearer": []}]

out = Path(__file__).resolve().parent.parent / "docs" / "openapi.json"
out.write_text(json.dumps(spec, indent=2) + "\n")
print(f"wrote {out} ({len(spec['paths'])} paths)")
