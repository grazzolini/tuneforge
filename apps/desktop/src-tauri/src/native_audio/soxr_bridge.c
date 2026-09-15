#include "soxr_bridge.h"

#include <soxr.h>

int tuneforge_soxr_resample_f32(
    float const *input,
    size_t input_length,
    double input_rate,
    double output_rate,
    float *output,
    size_t output_capacity,
    size_t *output_length) {
  soxr_error_t error = NULL;
  soxr_t resampler = soxr_create(input_rate, output_rate, 1, &error, NULL, NULL, NULL);
  if (resampler == NULL || error != NULL) {
    soxr_delete(resampler);
    return 1;
  }

  size_t input_done = 0;
  size_t output_done = 0;
  while (input_done < input_length && output_done < output_capacity) {
    size_t consumed = 0;
    size_t produced = 0;
    error = soxr_process(
        resampler,
        input + input_done,
        input_length - input_done,
        &consumed,
        output + output_done,
        output_capacity - output_done,
        &produced);
    if (error != NULL || (consumed == 0 && produced == 0)) {
      soxr_delete(resampler);
      return 2;
    }
    input_done += consumed;
    output_done += produced;
  }
  while (output_done < output_capacity) {
    size_t produced = 0;
    error = soxr_process(
        resampler,
        NULL,
        0,
        NULL,
        output + output_done,
        output_capacity - output_done,
        &produced);
    if (error != NULL) {
      soxr_delete(resampler);
      return 3;
    }
    output_done += produced;
    if (produced == 0) {
      break;
    }
  }
  soxr_delete(resampler);
  *output_length = output_done;
  return input_done == input_length ? 0 : 4;
}
