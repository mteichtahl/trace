#include "adc.h"

#include <stdio.h>

/* (R1 + R2) / R2 kept as a fraction so the ratio is exact: 52000 / 13000. */
#define DIV_NUM (DIVIDER_R1_OHM + DIVIDER_R2_OHM)
#define DIV_DEN DIVIDER_R2_OHM

uint32_t adc_counts_to_input_mv(uint32_t counts)
{
    if (counts > ADC_FULL_SCALE) counts = ADC_FULL_SCALE;
    /* counts * 3300 * 52000 < 2^32 * 13000 * 4095: use 64 bits for the product, then round. */
    uint64_t num = (uint64_t)counts * ADC_VREF_MV * DIV_NUM;
    uint64_t den = (uint64_t)ADC_FULL_SCALE * DIV_DEN;
    return (uint32_t)((num + den / 2u) / den);
}

uint32_t input_mv_to_adc_counts(uint32_t input_mv)
{
    uint64_t num = (uint64_t)input_mv * ADC_FULL_SCALE * DIV_DEN;
    uint64_t den = (uint64_t)ADC_VREF_MV * DIV_NUM;
    uint64_t counts = (num + den / 2u) / den;
    return counts > ADC_FULL_SCALE ? ADC_FULL_SCALE : (uint32_t)counts;
}

uint32_t adc_pin_mv_to_counts(uint32_t pin_mv)
{
    uint64_t counts = (uint64_t)pin_mv * ADC_FULL_SCALE / ADC_VREF_MV;
    return counts > ADC_FULL_SCALE ? ADC_FULL_SCALE : (uint32_t)counts;
}

int adc_format_line(char *out, unsigned size, uint32_t counts)
{
    return snprintf(out, size, "adc raw=%u mv=%u", (unsigned)counts, (unsigned)adc_counts_to_input_mv(counts));
}
