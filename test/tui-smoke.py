"""Exercise /talk/widget/editor integration in real Pi with synthetic mic input.
No microphone, model requests, auth access, or network required.
Run: python3 test/tui-smoke.py
"""
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent

def run(width, onboarding=False):
    with tempfile.TemporaryDirectory(prefix="dictate-pi-test-") as agent_dir:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, width, 0, 0))
        env = dict(os.environ, PI_CODING_AGENT_DIR=agent_dir, PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color", PI_DICTATE_TEST_ONBOARD="1" if onboarding else "0")
        process = subprocess.Popen([
            "pi", "--offline", "--no-session", "--no-extensions", "--no-skills",
            "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
            "--tui-mode", "regular", "-e", str(ROOT / "test/tui-fixture.ts"),
        ], stdin=slave, stdout=slave, stderr=slave, cwd=ROOT, env=env, start_new_session=True)
        os.close(slave)
        output = bytearray()
        def drain(seconds):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    output.extend(chunk)
        try:
            drain(2)
            os.write(master, b"/talk\r")  # Submit the command to start recording.
            if onboarding:
                drain(0.5)
                assert b"Set up local dictation?" in output
                os.write(master, b"\x1b")  # Decline first; no installation or recording.
                drain(0.3)
                assert b"Downloading model" not in output
                assert "● Recording".encode() not in output
                os.write(master, b"/talk\r")
                drain(0.5)
                os.write(master, b"\r")  # Explicitly approve setup.
                drain(0.2)
                os.write(master, b"\r")  # Extra Enter during setup must not submit.
            drain(1.2)
            os.write(master, b"Existing draft:")  # Preserve edits made while recording.
            drain(0.2)
            os.write(master, b"\r")  # Enter transcribes, never submits the draft.
            drain(0.2)
            os.write(master, b"\r")  # A repeated Enter during inference is consumed.
            drain(1.3)
            os.write(master, b"\x03")  # Clear the transcript without submitting it.
            drain(0.2)
            os.write(master, b"/talk\r")
            drain(0.5)
            os.write(master, b"\x1b")  # Escape cancels second recording
            drain(0.5)
            os.write(master, b"\x03")  # Clear prompt, don't submit it
            drain(0.2)
            os.write(master, b"\x04")  # Exit
            drain(0.5)
            text = output.decode("utf-8", "replace")
            (ROOT / ".scratch").mkdir(exist_ok=True)
            capture = f"tui-{'setup-' if onboarding else ''}{width}.ansi"
            (ROOT / ".scratch" / capture).write_text(text)
            if onboarding:
                assert "Downloading model" in text
                assert "Setup complete." in text
            for expected in ["Recording", "Transcribing", "Existing draft: Synthetic dictation", "inserted."]:
                assert expected in text, f"{width} cols missing {expected}; see .scratch/tui-{width}.ansi"
            assert "Failed to load extension" not in text, text
            print(f"PASS: real Pi TUI at {width} columns — {'first-run setup, ' if onboarding else ''} /talk, Enter-to-transcribe, insert, cancel")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
            os.close(master)

for onboarding in [False, True]:
    for columns in [80, 40]:
        run(columns, onboarding)
