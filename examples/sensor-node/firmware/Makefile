# sensor-node firmware module, built and tested on the host with its C compiler (cc), so it runs anywhere.
#   make        build/libadc.a  (the module an MCU project links)
#   make test   build and run the unit test
#   make clean
CC      ?= cc
CFLAGS  ?= -std=c99 -O2 -Wall -Wextra -Werror -pedantic
BUILD   := build

all: $(BUILD)/libadc.a

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/adc.o: adc.c adc.h | $(BUILD)
	$(CC) $(CFLAGS) -c adc.c -o $@

$(BUILD)/libadc.a: $(BUILD)/adc.o
	$(AR) rcs $@ $^

$(BUILD)/test_adc: test_adc.c $(BUILD)/libadc.a
	$(CC) $(CFLAGS) test_adc.c -L$(BUILD) -ladc -o $@

test: $(BUILD)/test_adc
	./$(BUILD)/test_adc

clean:
	rm -rf $(BUILD)

.PHONY: all test clean
