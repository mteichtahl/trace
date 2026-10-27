/*
 * The trace-sample console, built for the host so it runs anywhere (`make`, then build/trace-sample-fw.elf).
 *
 * It prints what the board's MCU prints on its UART at 115200 8N1 (the bench emulator's bench-uart speaks the same
 * lines): a boot line, then one reading per line. On the host the ADC is a command-line argument, the voltage at the
 * ADC pin in millivolts (default 3000, which is 12 V at J1):
 *
 *     $ build/trace-sample-fw.elf 3000 3
 *     boot trace-sample fw 0.1.0
 *     adc raw=3722 mv=11998
 *     adc raw=3722 mv=11998
 *     adc raw=3722 mv=11998
 */
#include <stdio.h>
#include <stdlib.h>
#include "adc.h"

#define FW_VERSION "0.1.0"

int main(int argc, char **argv)
{
    uint32_t pin_mv = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 10) : 3000u;
    int lines = argc > 2 ? atoi(argv[2]) : 1;
    char line[64];
    printf("boot trace-sample fw " FW_VERSION "\n");
    for (int i = 0; i < lines; i++) {
        adc_format_line(line, sizeof line, adc_pin_mv_to_counts(pin_mv));
        printf("%s\n", line);
    }
    return 0;
}
