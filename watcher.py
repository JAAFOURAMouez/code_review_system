
"""
File watcher for the Code Review & Improvement System.

Watches the src/ directory for Python file changes and runs
the orchestrator when a file is modified or created.

Uses polling to ensure reliable detection under WSL when the
project is located on a Windows-mounted filesystem (/mnt/c).
"""

import os
import sys
import time
import subprocess
from pathlib import Path


def get_python_executable():
    """Get the Python executable, preferring the project virtual environment."""
    project_dir = Path(__file__).resolve().parent

    # Linux / WSL virtual environment
    venv_python = project_dir / ".venv" / "bin" / "python"

    if venv_python.is_file():
        return str(venv_python)

    # Fallback to the current Python interpreter
    return sys.executable


def run_orchestrator(file_path: str):
    """Run the orchestrator on the given Python file."""
    project_dir = Path(__file__).resolve().parent
    orchestrator_path = project_dir / "orchestrator.py"
    absolute_file_path = str(Path(file_path).resolve())

    if not orchestrator_path.is_file():
        print(
            f"Error: orchestrator.py not found at {orchestrator_path}",
            file=sys.stderr,
            flush=True,
        )
        return

    print(
        f"\nDetected change in {absolute_file_path}. "
        "Running orchestrator...",
        flush=True,
    )

    try:
        result = subprocess.run(
            [
                get_python_executable(),
                str(orchestrator_path),
                absolute_file_path,
            ],
            cwd=str(project_dir),
            capture_output=False,
            timeout=60,
        )

        if result.returncode != 0:
            print(
                f"Orchestrator exited with code {result.returncode}",
                file=sys.stderr,
                flush=True,
            )

    except subprocess.TimeoutExpired:
        print(
            f"Orchestrator timed out while processing {absolute_file_path}",
            file=sys.stderr,
            flush=True,
        )

    except Exception as e:
        print(
            f"Error running orchestrator: {e}",
            file=sys.stderr,
            flush=True,
        )


def start_polling_watch(path_to_watch: str, poll_interval: float = 1.0):
    """
    Watch Python files using polling.

    Existing files are registered at startup without running the
    orchestrator. New or modified Python files trigger a review.
    """
    watch_path = Path(path_to_watch).resolve()

    if not watch_path.is_dir():
        print(
            f"Error: '{watch_path}' is not a directory.",
            file=sys.stderr,
            flush=True,
        )
        return

    print(
        f"Watching {watch_path} "
        f"(polling every {poll_interval}s)...",
        flush=True,
    )

    # Store the last known modification time of each Python file.
    last_modified = {}

    def scan_files():
        """Return the current modification times of Python files."""
        current_files = {}

        for root, dirs, files in os.walk(watch_path):
            # Ignore generated/cache directories.
            dirs[:] = [
                directory
                for directory in dirs
                if directory not in {"__pycache__", ".git", ".venv", "venv"}
            ]

            for filename in files:
                if not filename.endswith(".py"):
                    continue

                file_path = os.path.join(root, filename)

                try:
                    current_files[file_path] = os.path.getmtime(file_path)
                except OSError:
                    # The file may have disappeared during the scan.
                    continue

        return current_files

    # Register existing files without triggering reviews at startup.
    last_modified.update(scan_files())

    try:
        while True:
            time.sleep(poll_interval)

            current_files = scan_files()

            # Detect new and modified files.
            for file_path, mtime in current_files.items():
                previous_mtime = last_modified.get(file_path)

                if previous_mtime is None:
                    print(
                        f"\nNew Python file detected: {file_path}",
                        flush=True,
                    )
                    run_orchestrator(file_path)

                elif mtime > previous_mtime:
                    print(
                        f"\nChange detected in {file_path}",
                        flush=True,
                    )
                    run_orchestrator(file_path)

                last_modified[file_path] = mtime

            # Remove files that no longer exist from the state.
            for file_path in list(last_modified):
                if file_path not in current_files:
                    del last_modified[file_path]

    except KeyboardInterrupt:
        print("\nWatcher stopped.", flush=True)


def main():
    """Start watching the requested directory."""
    project_dir = Path(__file__).resolve().parent

    # Default directory to watch.
    path_to_watch = project_dir / "src"

    # Optional directory passed through the command line.
    if len(sys.argv) > 1:
        supplied_path = Path(sys.argv[1])

        if not supplied_path.is_absolute():
            supplied_path = Path.cwd() / supplied_path

        path_to_watch = supplied_path.resolve()

    if not path_to_watch.is_dir():
        print(
            f"Error: '{path_to_watch}' is not a directory.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    # Polling is used because watchdog events were not detected
    # reliably on the Windows-mounted filesystem under WSL.
    start_polling_watch(str(path_to_watch), poll_interval=1.0)


if __name__ == "__main__":
    main()