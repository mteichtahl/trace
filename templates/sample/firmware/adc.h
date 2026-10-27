/*
 * ADC counts to the trace-sample input voltage (J1, the 12 V rail).
 *
 * The board divides the 0-12 V input by R1/R2 = 39k/13k, so the ADC sees Vin * 13 / (39 + 13) = Vin / 4. A 12-bit ADC
 * referenced to the 3.3 V rail reads 0..4095 for 0..3.3 V at its pin, so
 *
 *     Vin = counts / 4095 * 3.3 V * 4
 *
 * Integer millivolts, rounded to nearest, no floating point (small MCUs often have no FPU).
 */
#ifndef TRACE_SAMPLE_ADC_H
#define TRACE_SAMPLE_ADC_H

#include <stdint.h>

#define ADC_BITS        12u
#define ADC_FULL_SCALE  ((1u << ADC_BITS) - 1u)   /* 4095 */
#define ADC_VREF_MV     3300u                      /* the ADC reference: the 3V3 rail */
#define DIVIDER_R1_OHM  39000u                     /* R1, top */
#define DIVIDER_R2_OHM  13000u                     /* R2, bottom */

/* Input voltage at J1 in millivolts for an ADC reading (readings above full scale are clamped to it). */
uint32_t adc_counts_to_input_mv(uint32_t counts);

/* The reading expected for an input voltage, the inverse of the above (for thresholds); clamped to full scale. */
uint32_t input_mv_to_adc_counts(uint32_t input_mv);

/* What a truncating 12-bit SAR ADC returns for a voltage at its pin (millivolts): floor(mv / 3300 * 4095). The
 * bench emulator's ADC behaves this way, so 12 V in (3000 mV at the pin) reads 3722, not the rounded 3723. */
uint32_t adc_pin_mv_to_counts(uint32_t pin_mv);

/* One console line for a reading: "adc raw=3722 mv=11998" (no newline). Returns the length written, at most
 * `size` - 1; `out` is always terminated. */
int adc_format_line(char *out, unsigned size, uint32_t counts);

#endif
