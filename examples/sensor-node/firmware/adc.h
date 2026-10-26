/*
 * ADC counts to the sensor-node input voltage.
 *
 * The board divides the 0-12 V input by R1/R2 = 39k/13k, so the ADC sees Vin * 13 / (39 + 13) = Vin / 4. A 12-bit ADC
 * referenced to the 3.3 V rail reads 0..4095 for 0..3.3 V at its pin, so
 *
 *     Vin = counts / 4095 * 3.3 V * 4
 *
 * Integer millivolts, rounded to nearest, no floating point (small MCUs often have no FPU).
 */
#ifndef SENSOR_NODE_ADC_H
#define SENSOR_NODE_ADC_H

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

#endif
