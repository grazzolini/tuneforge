#ifndef TUNEFORGE_FFMPEG_BRIDGE_H
#define TUNEFORGE_FFMPEG_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TfFfmpegJob TfFfmpegJob;
typedef int (*TfFfmpegCancelCallback)(void *opaque);
typedef void (*TfFfmpegProgressCallback)(void *opaque, int progress);

typedef struct TfFfmpegRenderRequest {
  const char *input_path;
  const char *output_path;
  const char *output_format;
  double pitch_cents;
  void *callback_opaque;
  TfFfmpegCancelCallback should_cancel;
  TfFfmpegProgressCallback on_progress;
} TfFfmpegRenderRequest;

TfFfmpegJob *tf_ffmpeg_job_create(void);
void tf_ffmpeg_job_destroy(TfFfmpegJob *job);
int tf_ffmpeg_render(TfFfmpegJob *job, const TfFfmpegRenderRequest *request);
const char *tf_ffmpeg_job_error(const TfFfmpegJob *job);
int tf_ffmpeg_job_output_sample_rate(const TfFfmpegJob *job);
int tf_ffmpeg_job_output_channels(const TfFfmpegJob *job);
int64_t tf_ffmpeg_job_output_samples(const TfFfmpegJob *job);

#ifdef __cplusplus
}
#endif

#endif
