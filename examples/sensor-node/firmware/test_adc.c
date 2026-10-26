/* Host unit test for adc.c: `make test`. Exits non-zero on the first failure. */
#include <stdio.h>
#include <stdlib.h>
#include "adc.h"

static int failures;

static void expect_eq(const char *what, uint32_t got, uint32_t want)
{
    if (got != want) {
        printf("FAIL %s: got %u, want %u\n", what, (unsigned)got, (unsigned)want);
        failures++;
    } else {
        printf("ok   %s = %u\n", what, (unsigned)got);
    }
}

int main(void)
{
    /* the ends of the range */
    expect_eq("0 counts -> mV", adc_counts_to_input_mv(0), 0);
    expect_eq("4095 counts -> mV (3.3 V at the pin = 13.2 V in)", adc_counts_to_input_mv(4095), 13200);
    expect_eq("above full scale clamps", adc_counts_to_input_mv(5000), 13200);
    /* 12 V in -> 3.0 V at the pin -> 3.0 / 3.3 * 4095 = 3722.7 counts */
    expect_eq("12000 mV -> counts", input_mv_to_adc_counts(12000), 3723);
    /* and back: 3723 / 4095 * 13.2 V = 12.0013 V (a count is 3.2 mV, so 12 V reads within one count) */
    expect_eq("3723 counts -> mV", adc_counts_to_input_mv(3723), 12001);
    /* one count is 3.3 V * 4 / 4095 = 3.22 mV at the input */
    expect_eq("1 count -> mV", adc_counts_to_input_mv(1), 3);
    /* round trip over the whole range stays within one count */
    for (uint32_t c = 0; c <= ADC_FULL_SCALE; c++) {
        uint32_t back = input_mv_to_adc_counts(adc_counts_to_input_mv(c));
        if (back + 1u < c || back > c + 1u) {
            printf("FAIL round trip %u -> %u\n", (unsigned)c, (unsigned)back);
            failures++;
            break;
        }
    }
    if (failures) {
        printf("%d FAILED\n", failures);
        return EXIT_FAILURE;
    }
    printf("ALL TESTS PASSED\n");
    return EXIT_SUCCESS;
}
