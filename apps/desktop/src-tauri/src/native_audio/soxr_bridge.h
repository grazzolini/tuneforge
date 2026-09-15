#ifndef TUNEFORGE_SOXR_BRIDGE_H
#define TUNEFORGE_SOXR_BRIDGE_H

#include <stddef.h>

int tuneforge_soxr_resample_f32(
    float const *input,
    size_t input_length,
    double input_rate,
    double output_rate,
    float *output,
    size_t output_capacity,
    size_t *output_length);

#endif
