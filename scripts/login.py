"""Return a fresh hosted Garmin session to the setup process through a pipe."""

import contextlib
import getpass
import json
import logging
import os
import sys


def main() -> int:
    if sys.stdout.isatty():
        print("Run npm run setup; this helper sends credentials through a private pipe.", file=sys.stderr)
        return 1

    # Do not reuse another client's rotating Garmin session or enable library logs.
    os.environ.pop("GARMINTOKENS", None)
    os.environ.pop("GARMINTOKENS_BASE64", None)
    logging.disable(logging.CRITICAL)
    try:
        from garminconnect import Garmin

        with open("/dev/tty", "r+") as terminal:
            terminal.write("Garmin email: ")
            terminal.flush()
            email = terminal.readline().strip()
            password = getpass.getpass("Garmin password: ", stream=terminal)

            def mfa_code() -> str:
                return getpass.getpass("Garmin verification code: ", stream=terminal)

            # Dependency diagnostics must never contaminate the credential pipe.
            with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                client = Garmin(email, password, prompt_mfa=mfa_code)
                client.login()
            session = {
                "di_token": client.client.di_token,
                "di_refresh_token": client.client.di_refresh_token,
                "di_client_id": client.client.di_client_id,
            }
            if not all(isinstance(value, str) and value for value in session.values()):
                raise ValueError("Incomplete session")
        sys.stdout.write(json.dumps(session))
        return 0
    except (Exception, KeyboardInterrupt):
        print("Garmin sign-in failed or was cancelled. No credentials were printed. Try again later if rate limited.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
