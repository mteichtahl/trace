"""cocotb tests for moving_average (the same checks as moving_average_tb.v, written in Python).

Run them with trace:  trace tool verify.cocotb files='["moving_average.v"]' top=moving_average modules='["test_moving_average.py"]'
Each test prints TRACE_COVER lines for the cases it reached; verify.coverage counts them as functional coverage.
"""
import random

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge

FULL = (1 << 12) - 1


class Model:
    """The expected average: the mean of the last four samples, missing ones counting as zero."""

    def __init__(self):
        self.hist = [0, 0, 0, 0]

    def push(self, s):
        self.hist = [s] + self.hist[:3]
        return sum(self.hist) // 4


async def start(dut):
    clock = Clock(dut.clk, 10, "ns")
    # cocotb 2.x starts a Clock with .start(); 1.x the same
    cocotb.start_soon(clock.start())
    dut.rst.value = 1
    dut.valid.value = 0
    dut.sample.value = 0
    for _ in range(3):
        await FallingEdge(dut.clk)
    dut.rst.value = 0
    return Model()


async def push(dut, model, s):
    want = model.push(s)
    dut.sample.value = s
    dut.valid.value = 1
    await FallingEdge(dut.clk)
    dut.valid.value = 0
    assert int(dut.avg_valid.value) == 1, f"avg_valid not set after sample {s}"
    got = int(dut.avg.value)
    assert got == want, f"after sample {s}: avg {got}, expected {want}"
    await FallingEdge(dut.clk)
    assert int(dut.avg_valid.value) == 0, "avg_valid held for more than one clock"
    return got


@cocotb.test()
async def step_and_full_scale(dut):
    """A step to 3723 (12 V in) climbs in quarters; full scale averages to full scale."""
    m = await start(dut)
    seen = [await push(dut, m, 3723) for _ in range(5)]
    assert seen[:4] == [930, 1861, 2792, 3723]
    for _ in range(4):
        got = await push(dut, m, FULL)
    assert got == FULL
    print("TRACE_COVER full_scale")
    for _ in range(4):
        got = await push(dut, m, 0)
    assert got == 0
    print("TRACE_COVER back_to_zero")


@cocotb.test()
async def random_with_gaps(dut):
    """Random samples with random idle clocks between them."""
    m = await start(dut)
    rng = random.Random(0x5EED)
    for _ in range(200):
        for _ in range(rng.randrange(8)):
            await FallingEdge(dut.clk)
        await push(dut, m, rng.randrange(FULL + 1))
    print("TRACE_COVER random_200")


@cocotb.test()
async def reset_clears_history(dut):
    """A reset in the middle of a stream clears the history."""
    m = await start(dut)
    for _ in range(4):
        await push(dut, m, 2000)
    dut.rst.value = 1
    await FallingEdge(dut.clk)
    dut.rst.value = 0
    m = Model()
    assert await push(dut, m, 400) == 100
    print("TRACE_COVER reset_mid_stream")
