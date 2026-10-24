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

def run(width):
    with tempfile.TemporaryDirectory(prefix="dictate-pi-test-") as agent_dir:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, width, 0, 0))
        env = dict(os.environ, PI_CODING_AGENT_DIR=agent_dir, PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
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
            (ROOT / f".scratch/tui-{width}.ansi").write_text(text)
            for expected in ["Recording", "Transcribing", "Existing draft: Synthetic dictation", "inserted."]:
                assert expected in text, f"{width} cols missing {expected}; see .scratch/tui-{width}.ansi"
            assert "Failed to load extension" not in text, text
            print(f"PASS: real Pi TUI at {width} columns — /talk, waveform, Enter-to-transcribe, insert, cancel")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
            os.close(master)

for columns in [80, 40]:
    run(columns)
