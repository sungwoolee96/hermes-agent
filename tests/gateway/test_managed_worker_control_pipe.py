"""The managed worker takes its control pipe off fd 0 before the first read.

On Windows a control reader blocked in the CRT ``read`` on fd 0 deadlocked numpy's first native
load (OpenBLAS under the holographic memory provider), so no Kanban turn ever started, and a child
inheriting the pipe as stdin (``git --version`` in the version stamp) stalled until its timeout.
"""
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]

# The worker's real stdio sequence: take the pipe, read the bootstrap, park a control reader.
CHILD = textwrap.dedent('''
    import os, subprocess, sys, threading, time
    sys.path.insert(0, sys.argv[1])
    from agent.managed_worker import read_frame, take_control_pipe
    control = take_control_pipe()
    out = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    bootstrap = read_frame(control)
    frames = []
    def reader():
        while True:
            try:
                frames.append(read_frame(control))
            except EOFError:
                return
    threading.Thread(target=reader, daemon=True).start()
    time.sleep(0.5)
    out.write("bootstrap=%s\\n" % bootstrap["n"])
    out.write("fd0=%r\\n" % sys.stdin.buffer.read())
    started = time.monotonic()
    child = subprocess.run([sys.executable, "-c", "import sys; sys.stdin.read()"], timeout=10)
    out.write("child_rc=%s child_s=%.2f\\n" % (child.returncode, time.monotonic() - started))
    if sys.argv[2] == "numpy":
        started = time.monotonic()
        import numpy
        out.write("numpy_s=%.2f\\n" % (time.monotonic() - started))
    deadline = time.monotonic() + 5
    while len(frames) < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    out.write("controls=%s\\n" % ",".join(f["type"] for f in frames))
''')


def _run(mode):
    process = subprocess.Popen([sys.executable, '-c', CHILD, str(ROOT), mode], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        # Bootstrap and the first control frame in ONE write: the frame behind the bootstrap
        # must reach the control reader, not stay behind in a buffer the reader never sees.
        process.stdin.write(b'{"n":1}\n{"type":"stop"}\n')
        process.stdin.flush()
        time.sleep(1.5)
        process.stdin.write(b'{"type":"finish"}\n')
        process.stdin.flush()
        out, err = process.communicate(timeout=60)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    assert process.returncode == 0, err.decode(errors='replace')
    return dict(line.split('=', 1) for line in out.decode().split() if '=' in line)


def test_control_pipe_leaves_fd0_null_and_keeps_every_frame():
    seen = _run('plain')
    assert seen['bootstrap'] == '1'
    assert seen['fd0'] == "b''"  # fd 0 is the null device: nothing else can read or hold the pipe
    assert seen['child_rc'] == '0' and float(seen['child_s']) < 5  # an inheriting child sees EOF at once
    assert seen['controls'] == 'stop,finish'


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows CRT fd-0 lock deadlock regression')
def test_first_numpy_import_beside_a_parked_control_reader_completes():
    pytest.importorskip('numpy')
    seen = _run('numpy')
    assert float(seen['numpy_s']) < 30
    assert seen['controls'] == 'stop,finish'


def test_memory_warm_up_runs_only_where_memory_is_used(monkeypatch):
    from agent import managed_worker
    from plugins import memory

    calls = []
    monkeypatch.setattr(memory, 'import_memory_provider_module', lambda: calls.append('warm') or True)
    monkeypatch.setattr(managed_worker.sys, 'platform', 'win32')
    managed_worker.warm_memory_provider_import(SimpleNamespace(ignore_rules=True))
    assert calls == []
    managed_worker.warm_memory_provider_import(SimpleNamespace(ignore_rules=False))
    assert calls == ['warm']
    monkeypatch.setattr(managed_worker.sys, 'platform', 'linux')
    managed_worker.warm_memory_provider_import(SimpleNamespace(ignore_rules=False))
    assert calls == ['warm']


def test_memory_warm_up_failure_is_left_to_agent_init(monkeypatch):
    from agent import managed_worker
    from plugins import memory

    def boom():
        raise RuntimeError('provider import failed')
    monkeypatch.setattr(memory, 'import_memory_provider_module', boom)
    monkeypatch.setattr(managed_worker.sys, 'platform', 'win32')
    managed_worker.warm_memory_provider_import(SimpleNamespace(ignore_rules=False))  # no raise
