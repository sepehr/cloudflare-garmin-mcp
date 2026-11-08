import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


spec = importlib.util.spec_from_file_location("plugin_packager", Path(__file__).parents[1] / "scripts/package_plugins.py")
assert spec is not None and spec.loader is not None
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def test_archives_have_host_layouts_oauth_and_only_explicit_files(self):
        url = "https://garmin.example.test/mcp"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            paths = packager.build_plugins(output, url)
            common = {"README.md", "LICENSE", "skills/garmin/SKILL.md"}
            for path, manifest, connection in [
                (paths[0], "plugin.json", "mcp.json"),
                (paths[1], ".claude-plugin/plugin.json", ".mcp.json"),
            ]:
                with zipfile.ZipFile(path) as archive:
                    self.assertIsNone(archive.testzip())
                    self.assertEqual(set(archive.namelist()), common | {manifest, connection})
                    metadata = json.loads(archive.read(manifest))
                    self.assertEqual(metadata["version"], json.loads((packager.ROOT / "package.json").read_text())["version"])
                    server = json.loads(archive.read(connection))["mcpServers"]["garmin"]
                    self.assertEqual(server["url"], url)
                    self.assertNotIn("headers", server)
                    if connection == "mcp.json":
                        self.assertEqual(server["type"], "streamable-http")
                        auth = server["extensions"]["com.openai"]["auth"]
                        self.assertEqual(auth["type"], "oauth")
                        self.assertEqual(auth["client"], {"mode": "dcr"})
                        self.assertEqual(auth["baseScopes"], ["garmin:read", "offline_access"])
                    else:
                        self.assertEqual(server["type"], "http")
                        self.assertEqual(server["oauth"], {"scopes": "garmin:read offline_access"})
            for line in (output / "SHA256SUMS").read_text().splitlines():
                digest, name = line.split("  ")
                self.assertEqual(digest, hashlib.sha256((output / name).read_bytes()).hexdigest())

    def test_url_is_customizable_and_archives_are_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            first = packager.build_plugins(Path(directory) / "first", "https://custom.example.test/mcp")
            second = packager.build_plugins(Path(directory) / "second", "https://custom.example.test/mcp")
            self.assertEqual([p.read_bytes() for p in first], [p.read_bytes() for p in second])
            with zipfile.ZipFile(first[1]) as archive:
                self.assertEqual(json.loads(archive.read(".mcp.json"))["mcpServers"]["garmin"]["url"], "https://custom.example.test/mcp")

    def test_invalid_or_credential_bearing_urls_write_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            for url in ["http://example.test/mcp", "https://user:fixture-secret@example.test/mcp",
                        "https://example.test/mcp?token=fixture-secret", "https://example.test/mcp#token",
                        "https://example.test/other", "https://example.test:invalid/mcp", "https://bad host/mcp"]:
                with self.assertRaises(ValueError):
                    packager.build_plugins(output, url)
                self.assertFalse(output.exists())

    def test_cli_rejects_credentials_without_echoing_them(self):
        result = subprocess.run([sys.executable, str(packager.ROOT / "scripts/package_plugins.py"),
                                 "--url", "https://user:fixture-secret@example.test/mcp"],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("fixture-secret", result.stdout + result.stderr)
