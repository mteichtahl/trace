"""A pseudo-terminal for the bench emulator (src/tools/hil/emulator/serial.ts): standard library only, POSIX only.

    python3 python/tracebridge/ptyrelay.py

Opens a pty, prints the path of its device end (/dev/pts/N) as the first line of stdout, then relays bytes: what
arrives on stdin is written to the terminal (the emulated firmware's output), and what a program writes to
/dev/pts/N comes out on stdout (commands to the firmware). The emulator in TypeScript plays the firmware; this only
gives it a device path that the serialport package opens like a USB serial adapter.

Like a UART with nothing connected, output written while no program has the device open is dropped, so a program
that opens it later reads only fresh lines. Exits when stdin closes.
"""
from __future__ import annotations

import errno
import os
import select
import sys
import termios
import tty


def attached(master: int) -> bool:
    """With no program holding the device end open, the master reports POLLHUP."""
    p = select.poll()
    p.register(master, select.POLLIN)
    return not any(ev & select.POLLHUP for _, ev in p.poll(0))


def main() -> int:
    master, slave = os.openpty()
    tty.setraw(slave)
    path = os.ttyname(slave)
    os.close(slave)
    os.set_blocking(master, False)
    stdin = sys.stdin.buffer.raw.fileno()
    out = sys.stdout.buffer
    out.write(f"{path}\n".encode())
    out.flush()

    was = False
    while True:
        now = attached(master)
        if was and not now:
            # the program closed the device: what it did not read is gone, as on a real port
            termios.tcflush(master, termios.TCIOFLUSH)
        was = now
        fds = [stdin, master] if now else [stdin]
        ready, _, _ = select.select(fds, [], [], 0.05)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno not in (errno.EIO, errno.EAGAIN):
                    raise
                data = b""
            if data:
                out.write(data)
                out.flush()
        if stdin in ready:
            data = os.read(stdin, 65536)
            if not data:
                return 0
            if now:
                try:
                    os.write(master, data)
                except OSError as e:
                    if e.errno not in (errno.EAGAIN, errno.EIO):
                        raise


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
