import importlib.util
import io
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("login_helper", Path(__file__).parents[1] / "scripts/login.py")
assert spec is not None and spec.loader is not None
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class LoginTests(unittest.TestCase):
    def run_login(self, should_fail=False):
        output = io.StringIO()
        errors = io.StringIO()
        terminal = io.StringIO("fixture@example.test\n")

        class FakeGarmin:
            def __init__(self, email, password, prompt_mfa):
                self.client = types.SimpleNamespace(
                    di_token="fixture-access", di_refresh_token="fixture-refresh", di_client_id="fixture-client"
                )

            def login(self):
                print("fixture-library-sensitive-diagnostic")
                print("fixture-library-sensitive-diagnostic", file=sys.stderr)
                if should_fail:
                    raise RuntimeError("fixture-sensitive-exception")

        real_open = open

        def open_file(path, *args, **kwargs):
            if path == "/dev/tty":
                return terminal
            return real_open(path, *args, **kwargs)

        with patch.object(sys, "stdout", output), patch.object(sys, "stderr", errors), \
                patch("builtins.open", open_file), patch.object(helper.getpass, "getpass", return_value="fixture-password"), \
                patch.dict(sys.modules, {"garminconnect": types.SimpleNamespace(Garmin=FakeGarmin)}), \
                patch.dict(os.environ, {"GARMINTOKENS": "must-not-be-used"}):
            result = helper.main()
            self.assertNotIn("GARMINTOKENS", os.environ)
        return result, output.getvalue(), errors.getvalue()

    def test_only_session_reaches_private_pipe(self):
        import json
        result, output, errors = self.run_login()
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output), {
            "di_token": "fixture-access", "di_refresh_token": "fixture-refresh", "di_client_id": "fixture-client"
        })
        self.assertEqual(errors, "")

    def test_failure_suppresses_credentials_and_library_diagnostics(self):
        result, output, errors = self.run_login(should_fail=True)
        self.assertEqual(result, 1)
        self.assertEqual(output, "")
        self.assertIn("sign-in failed", errors)
        self.assertNotIn("fixture-", errors)

    def test_interactive_stdout_refuses_to_print_session(self):
        output = io.StringIO()
        with patch.object(sys, "stdout", output), patch.object(output, "isatty", return_value=True), \
                patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(helper.main(), 1)
        self.assertEqual(output.getvalue(), "")
