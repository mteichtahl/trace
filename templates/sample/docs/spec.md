# Specification: trace-sample rev A

Requirements for the board, each with an acceptance criterion. They come from [intent.md](intent.md). trace's
verification specialist reads this file with `verify.requirements action=extract`, and the installer has already
stored these same requirements in `.trace/project.db` (table `requirements`), each with a test item.

Kinds: functional, electrical, timing, emc.

## Power

**REQ-PWR-001** (electrical). The board shall run from 4.5 V to 13 V at J1.
Acceptance: the 3V3 rail stays within 3.2 to 3.4 V for VIN from 4.5 V to 13 V.

**REQ-PWR-002** (electrical). The 3V3 rail shall supply at least 50 mA.
Acceptance: U1 dissipates at most 0.6 W at VIN = 12 V with a 43 mA load (`power/ldo.cir`).

## Analog front end

**REQ-ANA-001** (electrical). The ADC input shall read the rail as VIN / 4 within ±1 % of full scale.
Acceptance: ADC_IN = 1.47 to 1.53 V at VIN = 6 V across component, supply and temperature corners.

**REQ-ANA-002** (electrical). The anti-alias filter corner shall be between 850 Hz and 1250 Hz.
Acceptance: the -3 dB frequency of ADC_IN is 850 to 1250 Hz at mid-scale.

**REQ-ANA-003** (electrical). The buffer U2 shall be stable driving the ADC input.
Acceptance: phase margin at least 45 degrees as a follower with 10 pF load.

**REQ-ANA-004** (electrical). The front end noise at ADC_IN shall be below 0.1 LSB.
Acceptance: integrated output noise from 1 Hz to 1 MHz is at most 80 µV rms.

## Timing and interfaces

**REQ-TIM-001** (timing). A step at J1 shall settle at ADC_IN within 1 ms.
Acceptance: settling to 1 % within 1 ms.

**REQ-IF-001** (timing). The I2C bus shall meet fast-mode timing at 400 kHz.
Acceptance: every UM10204 fast-mode limit passes on the I2C capture (`protocol/i2c-tmp1-read.vcd`).

**REQ-IF-002** (timing). The console UART shall run at 115200 baud, 8N1.
Acceptance: baud error at most 2 % and no framing errors on the console capture.

**REQ-IF-003** (electrical). The I2C pull-ups shall give a rise time of at most 300 ns with 50 pF on the bus.
Acceptance: rise time at most 300 ns.

**REQ-IF-004** (timing). The status frame shall go out on CAN at 500 kbit/s once a second.
Acceptance: the frame with id 0x321 is decoded with a valid CRC.

## Logic and firmware

**REQ-FW-001** (functional). The firmware shall convert ADC counts to millivolts at the input.
Acceptance: 3722 counts read 11998 mV, and the host unit test passes.

**REQ-FW-002** (functional). The averaging filter shall output the mean of the last four samples.
Acceptance: the testbench, the cocotb tests and the formal properties all pass.

**REQ-FW-003** (timing). The FPGA build of the logic shall meet timing at 12 MHz.
Acceptance: the place and route closes with positive slack at 12 MHz on the iCE40 UP5K.

## Thermal

**REQ-THM-001** (electrical). U1's junction shall stay at least 20 °C below its maximum at 50 °C ambient.
Acceptance: junction temperature at most 105 °C at 50 °C ambient.

## EMC

**REQ-EMC-001** (emc). Radiated emissions shall meet CISPR 32 class B with at least 6 dB margin.
Acceptance: the pre-compliance estimate margin is at least 6 dB from 30 MHz to 1 GHz.

## Layout and build

**REQ-LAY-001** (functional). The board shall pass DRC and ERC with no errors.
Acceptance: KiCad ERC and DRC (with schematic parity) report 0 errors.

**REQ-LAY-002** (functional). Every part shall have an LCSC code and be in stock for 10 boards.
Acceptance: the BOM check flags no line.

## Bench

**REQ-HIL-001** (functional). On the bench at 12 V the board shall report the rail within 1 %.
Acceptance: the DMM reads 2.97 to 3.03 V on ADC_IN and the console prints a reading from 11880 to 12120 mV.
