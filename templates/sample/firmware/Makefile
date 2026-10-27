# trace-sample firmware, built and tested on the host with its C compiler (cc), so it runs anywhere.
#   make         build/libadc.a (the module an MCU project links) and build/trace-sample-fw.elf (the console, on the host)
#   make test    build and run the unit test
#   make flash   the bench has no MCU to program (the emulator models the board's analog side and its console):
#                checks the image exists and says so; on a real bench, replace it with the probe's command
#   make clean
TARGET  := trace-sample-fw
CC      ?= cc
CFLAGS  ?= -std=c99 -O2 -Wall -Wextra -Werror -pedantic
BUILD   := build

all: $(BUILD)/libadc.a $(BUILD)/$(TARGET).elf

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/adc.o: adc.c adc.h | $(BUILD)
	$(CC) $(CFLAGS) -c adc.c -o $@

$(BUILD)/libadc.a: $(BUILD)/adc.o
	$(AR) rcs $@ $^

$(BUILD)/$(TARGET).elf: main.c $(BUILD)/libadc.a
	$(CC) $(CFLAGS) main.c -L$(BUILD) -ladc -o $@

$(BUILD)/test_adc: test_adc.c $(BUILD)/libadc.a
	$(CC) $(CFLAGS) test_adc.c -L$(BUILD) -ladc -o $@

test: $(BUILD)/test_adc
	./$(BUILD)/test_adc

flash: $(BUILD)/$(TARGET).elf
	@echo "flash: $(BUILD)/$(TARGET).elf ($$(wc -c < $(BUILD)/$(TARGET).elf) bytes) is ready; the emulated bench has no MCU to program, so nothing was written"

clean:
	rm -rf $(BUILD)

.PHONY: all test flash clean
