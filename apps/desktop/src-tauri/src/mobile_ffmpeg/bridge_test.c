#include "bridge.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct TestCallbacks {
  int cancel_immediately;
  int cancel_after_progress;
  int last_progress;
} TestCallbacks;

static int should_cancel(void *opaque) {
  TestCallbacks *callbacks = (TestCallbacks *)opaque;
  return callbacks->cancel_immediately ||
         (callbacks->cancel_after_progress >= 0 &&
          callbacks->last_progress >= callbacks->cancel_after_progress);
}

static void on_progress(void *opaque, int progress) {
  ((TestCallbacks *)opaque)->last_progress = progress;
}

int main(int argc, char **argv) {
  if (argc != 6) {
    fprintf(stderr,
            "usage: bridge-test INPUT OUTPUT FORMAT CENTS CANCEL_MODE\n");
    return 64;
  }
  TestCallbacks callbacks = {
      .cancel_immediately = strcmp(argv[5], "immediate") == 0,
      .cancel_after_progress = strcmp(argv[5], "never") == 0
                                   ? -1
                                   : atoi(argv[5]),
      .last_progress = 0,
  };
  TfFfmpegRenderRequest request = {
      .input_path = argv[1],
      .output_path = argv[2],
      .output_format = argv[3],
      .pitch_cents = strtod(argv[4], NULL),
      .callback_opaque = &callbacks,
      .should_cancel = should_cancel,
      .on_progress = on_progress,
  };
  TfFfmpegJob *job = tf_ffmpeg_job_create();
  if (!job) return 70;
  int result = tf_ffmpeg_render(job, &request);
  fprintf(stderr, "result=%d progress=%d error=%s\n", result,
          callbacks.last_progress, tf_ffmpeg_job_error(job));
  tf_ffmpeg_job_destroy(job);
  if (result < 0) remove(argv[2]);
  return result < 0 ? 1 : 0;
}
