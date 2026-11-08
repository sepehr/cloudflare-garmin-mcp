"""Build credential-free ChatGPT and Claude plugin ZIPs from an explicit file list."""

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_URL = "https://garmin.example.test/mcp"


def validate_url(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != "/mcp"
            or re.search(r"[\s\\\x00-\x1f]", value)):
        raise ValueError("Use an HTTPS server URL ending in /mcp, without credentials or query parameters.")
    # Force validation of malformed ports before writing any files.
    parsed.port
    return value


def json_text(value: object) -> str:
    return json.dumps(value, indent=2) + "\n"


def build_plugins(output: Path, url: str = EXAMPLE_URL) -> list[Path]:
    url = validate_url(url)
    version = json.loads((ROOT / "package.json").read_text())["version"]
    metadata = {"name": "garmin", "version": version, "license": "MIT",
                "description": "Read-only Garmin activities, sleep, and health metrics through your own hosted MCP server."}
    skill = (ROOT / "plugins/skills/garmin/SKILL.md").read_text()
    readme = (ROOT / "plugins/README.md").read_text()
    readme += f"\nConfigured MCP URL: {url}\n"
    common = {"README.md": readme, "LICENSE": (ROOT / "LICENSE").read_text(),
              "skills/garmin/SKILL.md": skill}
    chatgpt = {
        **common,
        "plugin.json": json_text({"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", **metadata,
            "extensions": {"com.openai": {"interface": {"displayName": "Garmin", "shortDescription": "Read your Garmin data", "capabilities": ["Read"]}}}}),
        "mcp.json": json_text({"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers": {
            "garmin": {"type": "streamable-http", "url": url, "extensions": {"com.openai": {"auth": {
                "type": "oauth", "client": {"mode": "dcr"}, "baseScopes": ["garmin:read", "offline_access"]}}}}}}),
    }
    claude = {
        **common,
        ".claude-plugin/plugin.json": json_text({**metadata, "displayName": "Garmin", "author": {"name": "cloudflare-garmin-mcp contributors"}}),
        ".mcp.json": json_text({"mcpServers": {"garmin": {"type": "http", "url": url,
            "oauth": {"scopes": "garmin:read offline_access"}}}}),
    }
    output.mkdir(parents=True, exist_ok=True)
    paths = []
    for host, contents in [("chatgpt", chatgpt), ("claude", claude)]:
        path = output / f"garmin-{host}.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(contents.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, content.encode())
        paths.append(path)
    (output / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in paths))
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=EXAMPLE_URL, help="Your hosted HTTPS MCP URL; default builds example-URL templates.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/plugins")
    args = parser.parse_args()
    try:
        paths = build_plugins(args.output, args.url)
    except ValueError:
        parser.error("Invalid MCP URL. Use HTTPS ending in /mcp with no credentials, query, or fragment.")
    print("Built " + ", ".join(path.name for path in paths) + " and SHA256SUMS.")
    if args.url == EXAMPLE_URL:
        print("Templates only: replace the example MCP URL before importing.")


if __name__ == "__main__":
    main()
