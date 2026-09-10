#include "bridge.h"

#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
#include <libavutil/error.h>
#include <libavutil/log.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>

#include <math.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct TfFfmpegJob {
  char error[1024];
  const TfFfmpegRenderRequest *request;
  int output_sample_rate;
  int output_channels;
  int64_t output_samples;
};

typedef struct TfPipeline {
  AVFormatContext *input;
  AVFormatContext *output;
  AVCodecContext *decoder;
  AVCodecContext *encoder;
  AVFilterGraph *filters;
  AVFilterContext *source;
  AVFilterContext *sink;
  AVPacket *packet;
  AVFrame *decoded;
  AVFrame *filtered;
  int input_stream;
  int64_t encoded_samples;
  int last_progress;
} TfPipeline;

static void tf_set_error(TfFfmpegJob *job, const char *operation, int code) {
  char detail[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(code, detail, sizeof(detail));
  snprintf(job->error, sizeof(job->error), "%s: %s", operation, detail);
}

static int tf_cancelled(TfFfmpegJob *job) {
  const TfFfmpegRenderRequest *request = job->request;
  return request && request->should_cancel && request->should_cancel(request->callback_opaque);
}

static int tf_interrupt(void *opaque) { return tf_cancelled((TfFfmpegJob *)opaque); }

static void tf_progress(TfFfmpegJob *job, int progress) {
  if (job->request->on_progress) {
    job->request->on_progress(job->request->callback_opaque, progress);
  }
}

static const char *tf_encoder_name(const char *format) {
  if (strcmp(format, "wav") == 0) return "pcm_s16le";
  if (strcmp(format, "flac") == 0) return "flac";
  if (strcmp(format, "mp3") == 0) return "libmp3lame";
  if (strcmp(format, "m4a") == 0) return "aac";
  return NULL;
}

static void tf_close(TfPipeline *pipeline) {
  av_packet_free(&pipeline->packet);
  av_frame_free(&pipeline->decoded);
  av_frame_free(&pipeline->filtered);
  avfilter_graph_free(&pipeline->filters);
  avcodec_free_context(&pipeline->decoder);
  avcodec_free_context(&pipeline->encoder);
  if (pipeline->input) avformat_close_input(&pipeline->input);
  if (pipeline->output) {
    if (!(pipeline->output->oformat->flags & AVFMT_NOFILE) && pipeline->output->pb) {
      avio_closep(&pipeline->output->pb);
    }
    avformat_free_context(pipeline->output);
  }
}

static int tf_open_input(TfFfmpegJob *job, TfPipeline *pipeline) {
  pipeline->input = avformat_alloc_context();
  if (!pipeline->input) return AVERROR(ENOMEM);
  pipeline->input->interrupt_callback.callback = tf_interrupt;
  pipeline->input->interrupt_callback.opaque = job;
  int result = avformat_open_input(&pipeline->input, job->request->input_path, NULL, NULL);
  if (result < 0) return result;
  result = avformat_find_stream_info(pipeline->input, NULL);
  if (result < 0) return result;
  pipeline->input_stream = -1;
  for (unsigned int index = 0; index < pipeline->input->nb_streams; index += 1) {
    if (pipeline->input->streams[index]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      pipeline->input_stream = (int)index;
      break;
    }
  }
  if (pipeline->input_stream < 0) return AVERROR_STREAM_NOT_FOUND;
  AVStream *stream = pipeline->input->streams[pipeline->input_stream];
  const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) return AVERROR_DECODER_NOT_FOUND;
  pipeline->decoder = avcodec_alloc_context3(codec);
  if (!pipeline->decoder) return AVERROR(ENOMEM);
  result = avcodec_parameters_to_context(pipeline->decoder, stream->codecpar);
  if (result < 0) return result;
  pipeline->decoder->pkt_timebase = stream->time_base;
  return avcodec_open2(pipeline->decoder, codec, NULL);
}

static int tf_open_output(TfFfmpegJob *job, TfPipeline *pipeline) {
  const char *format = job->request->output_format;
  const char *muxer = strcmp(format, "m4a") == 0 ? "mp4" : format;
  int result = avformat_alloc_output_context2(&pipeline->output, NULL, muxer, job->request->output_path);
  if (result < 0 || !pipeline->output) return result < 0 ? result : AVERROR(EINVAL);
  const AVCodec *codec = avcodec_find_encoder_by_name(tf_encoder_name(format));
  if (!codec) return AVERROR_ENCODER_NOT_FOUND;
  pipeline->encoder = avcodec_alloc_context3(codec);
  if (!pipeline->encoder) return AVERROR(ENOMEM);
  int desired_rate = pipeline->decoder->sample_rate;
  if (desired_rate <= 0) return AVERROR(EINVAL);
  const int *sample_rates = NULL;
  int sample_rate_count = 0;
  result = avcodec_get_supported_config(
      pipeline->encoder, codec, AV_CODEC_CONFIG_SAMPLE_RATE, 0,
      (const void **)&sample_rates, &sample_rate_count);
  if (result < 0) return result;
  pipeline->encoder->sample_rate = desired_rate;
  if (sample_rate_count > 0) {
    int best_distance = INT_MAX;
    for (int index = 0; index < sample_rate_count; index += 1) {
      if (sample_rates[index] <= 0) continue;
      int distance = abs(sample_rates[index] - desired_rate);
      if (distance < best_distance) {
        pipeline->encoder->sample_rate = sample_rates[index];
        best_distance = distance;
      }
    }
  }
  AVChannelLayout desired_layout = {0};
  if (pipeline->decoder->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
    av_channel_layout_default(&desired_layout, pipeline->decoder->ch_layout.nb_channels);
  } else {
    result = av_channel_layout_copy(&desired_layout, &pipeline->decoder->ch_layout);
    if (result < 0) return result;
  }
  const AVChannelLayout *channel_layouts = NULL;
  int channel_layout_count = 0;
  result = avcodec_get_supported_config(
      pipeline->encoder, codec, AV_CODEC_CONFIG_CHANNEL_LAYOUT, 0,
      (const void **)&channel_layouts, &channel_layout_count);
  if (result < 0) {
    av_channel_layout_uninit(&desired_layout);
    return result;
  }
  const AVChannelLayout *selected_layout = &desired_layout;
  if (channel_layout_count > 0) {
    int best_distance = INT_MAX;
    for (int index = 0; index < channel_layout_count; index += 1) {
      if (channel_layouts[index].nb_channels <= 0) continue;
      int distance = abs(channel_layouts[index].nb_channels - desired_layout.nb_channels);
      if (av_channel_layout_compare(&channel_layouts[index], &desired_layout) == 0) {
        selected_layout = &channel_layouts[index];
        break;
      }
      if (distance < best_distance) {
        selected_layout = &channel_layouts[index];
        best_distance = distance;
      }
    }
  }
  result = av_channel_layout_copy(&pipeline->encoder->ch_layout, selected_layout);
  av_channel_layout_uninit(&desired_layout);
  if (result < 0) return result;
  const enum AVSampleFormat *sample_formats = NULL;
  int sample_format_count = 0;
  result = avcodec_get_supported_config(
      pipeline->encoder, codec, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
      (const void **)&sample_formats, &sample_format_count);
  if (result < 0) return result;
  pipeline->encoder->sample_fmt = sample_format_count > 0
                                      ? sample_formats[0]
                                      : pipeline->decoder->sample_fmt;
  pipeline->encoder->time_base = (AVRational){1, pipeline->encoder->sample_rate};
  if (strcmp(format, "mp3") == 0 || strcmp(format, "m4a") == 0) {
    pipeline->encoder->bit_rate = 192000;
  }
  if (strcmp(format, "flac") == 0) pipeline->encoder->compression_level = 5;
  if (pipeline->output->oformat->flags & AVFMT_GLOBALHEADER) {
    pipeline->encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  }
  result = avcodec_open2(pipeline->encoder, codec, NULL);
  if (result < 0) return result;
  AVStream *stream = avformat_new_stream(pipeline->output, NULL);
  if (!stream) return AVERROR(ENOMEM);
  stream->time_base = pipeline->encoder->time_base;
  result = avcodec_parameters_from_context(stream->codecpar, pipeline->encoder);
  if (result < 0) return result;
  if (!(pipeline->output->oformat->flags & AVFMT_NOFILE)) {
    result = avio_open(&pipeline->output->pb, job->request->output_path, AVIO_FLAG_WRITE);
    if (result < 0) return result;
  }
  return avformat_write_header(pipeline->output, NULL);
}

static int tf_open_filters(TfFfmpegJob *job, TfPipeline *pipeline) {
  pipeline->filters = avfilter_graph_alloc();
  if (!pipeline->filters) return AVERROR(ENOMEM);
  char layout[128] = {0};
  int result = av_channel_layout_describe(&pipeline->decoder->ch_layout, layout, sizeof(layout));
  if (result < 0) return result;
  const char *sample_name = av_get_sample_fmt_name(pipeline->decoder->sample_fmt);
  if (!sample_name) return AVERROR(EINVAL);
  char source_args[512] = {0};
  AVRational time_base = pipeline->input->streams[pipeline->input_stream]->time_base;
  snprintf(source_args, sizeof(source_args),
           "time_base=%d/%d:sample_rate=%d:sample_fmt=%s:channel_layout=%s",
           time_base.num, time_base.den, pipeline->decoder->sample_rate, sample_name, layout);
  result = avfilter_graph_create_filter(&pipeline->source, avfilter_get_by_name("abuffer"),
                                        "source", source_args, NULL, pipeline->filters);
  if (result < 0) return result;
  result = avfilter_graph_create_filter(&pipeline->sink, avfilter_get_by_name("abuffersink"),
                                        "sink", NULL, NULL, pipeline->filters);
  if (result < 0) return result;

  char encoder_layout[128] = {0};
  result = av_channel_layout_describe(&pipeline->encoder->ch_layout, encoder_layout, sizeof(encoder_layout));
  if (result < 0) return result;
  const char *encoder_sample_name = av_get_sample_fmt_name(pipeline->encoder->sample_fmt);
  double ratio = pow(2.0, job->request->pitch_cents / 1200.0);
  char chain[1024] = {0};
  if (fabs(job->request->pitch_cents) < 0.000001) {
    snprintf(chain, sizeof(chain),
             "aformat=sample_fmts=%s:sample_rates=%d:channel_layouts=%s",
             encoder_sample_name, pipeline->encoder->sample_rate, encoder_layout);
  } else {
    char tempo[512] = {0};
    double remaining = 1.0 / ratio;
    while (remaining < 0.5) {
      av_strlcat(tempo, "atempo=0.5,", sizeof(tempo));
      remaining /= 0.5;
    }
    while (remaining > 2.0) {
      av_strlcat(tempo, "atempo=2.0,", sizeof(tempo));
      remaining /= 2.0;
    }
    char final_tempo[64] = {0};
    snprintf(final_tempo, sizeof(final_tempo), "atempo=%.10f", remaining);
    av_strlcat(tempo, final_tempo, sizeof(tempo));
    snprintf(chain, sizeof(chain),
             "asetrate=%d*%.10f,aresample=%d,%s,aformat=sample_fmts=%s:sample_rates=%d:channel_layouts=%s",
             pipeline->decoder->sample_rate, ratio, pipeline->encoder->sample_rate, tempo,
             encoder_sample_name, pipeline->encoder->sample_rate, encoder_layout);
  }
  AVFilterInOut *inputs = avfilter_inout_alloc();
  AVFilterInOut *outputs = avfilter_inout_alloc();
  if (!inputs || !outputs) {
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);
    return AVERROR(ENOMEM);
  }
  outputs->name = av_strdup("in");
  outputs->filter_ctx = pipeline->source;
  outputs->pad_idx = 0;
  inputs->name = av_strdup("out");
  inputs->filter_ctx = pipeline->sink;
  inputs->pad_idx = 0;
  result = avfilter_graph_parse_ptr(pipeline->filters, chain, &inputs, &outputs, NULL);
  avfilter_inout_free(&inputs);
  avfilter_inout_free(&outputs);
  if (result < 0) return result;
  result = avfilter_graph_config(pipeline->filters, NULL);
  if (result < 0) return result;
  if (pipeline->encoder->frame_size > 0) {
    av_buffersink_set_frame_size(pipeline->sink, pipeline->encoder->frame_size);
  }
  return 0;
}

static int tf_encode_frame(TfPipeline *pipeline, AVFrame *frame) {
  int result = avcodec_send_frame(pipeline->encoder, frame);
  if (result < 0) return result;
  while (1) {
    result = avcodec_receive_packet(pipeline->encoder, pipeline->packet);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return 0;
    if (result < 0) return result;
    av_packet_rescale_ts(pipeline->packet, pipeline->encoder->time_base,
                         pipeline->output->streams[0]->time_base);
    pipeline->packet->stream_index = 0;
    result = av_interleaved_write_frame(pipeline->output, pipeline->packet);
    av_packet_unref(pipeline->packet);
    if (result < 0) return result;
  }
}

static int tf_drain_filters(TfFfmpegJob *job, TfPipeline *pipeline) {
  while (1) {
    int result = av_buffersink_get_frame(pipeline->sink, pipeline->filtered);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return 0;
    if (result < 0) return result;
    pipeline->filtered->pts = pipeline->encoded_samples;
    pipeline->encoded_samples += pipeline->filtered->nb_samples;
    result = tf_encode_frame(pipeline, pipeline->filtered);
    av_frame_unref(pipeline->filtered);
    if (result < 0) return result;
    if (tf_cancelled(job)) return AVERROR_EXIT;
  }
}

static int tf_decode_packet(TfFfmpegJob *job, TfPipeline *pipeline, AVPacket *packet) {
  int result = avcodec_send_packet(pipeline->decoder, packet);
  if (result < 0) return result;
  while (1) {
    result = avcodec_receive_frame(pipeline->decoder, pipeline->decoded);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return 0;
    if (result < 0) return result;
    result = av_buffersrc_add_frame_flags(pipeline->source, pipeline->decoded, AV_BUFFERSRC_FLAG_KEEP_REF);
    av_frame_unref(pipeline->decoded);
    if (result < 0) return result;
    result = tf_drain_filters(job, pipeline);
    if (result < 0) return result;
  }
}

static void tf_packet_progress(TfFfmpegJob *job, TfPipeline *pipeline,
                               const AVPacket *packet) {
  if (packet->pts == AV_NOPTS_VALUE || pipeline->input->duration <= 0) return;
  const AVStream *stream = pipeline->input->streams[pipeline->input_stream];
  int64_t elapsed = av_rescale_q(packet->pts, stream->time_base, AV_TIME_BASE_Q);
  if (stream->start_time != AV_NOPTS_VALUE) {
    elapsed -= av_rescale_q(stream->start_time, stream->time_base, AV_TIME_BASE_Q);
  }
  int progress = 10 + (int)av_rescale_rnd(elapsed, 80, pipeline->input->duration,
                                          AV_ROUND_DOWN);
  if (progress > 90) progress = 90;
  if (progress > pipeline->last_progress) {
    pipeline->last_progress = progress;
    tf_progress(job, progress);
  }
}

TfFfmpegJob *tf_ffmpeg_job_create(void) {
  av_log_set_level(AV_LOG_QUIET);
  return calloc(1, sizeof(TfFfmpegJob));
}

void tf_ffmpeg_job_destroy(TfFfmpegJob *job) { free(job); }

const char *tf_ffmpeg_job_error(const TfFfmpegJob *job) {
  return job ? job->error : "FFmpeg job was not allocated";
}

int tf_ffmpeg_job_output_sample_rate(const TfFfmpegJob *job) {
  return job ? job->output_sample_rate : 0;
}

int tf_ffmpeg_job_output_channels(const TfFfmpegJob *job) {
  return job ? job->output_channels : 0;
}

int64_t tf_ffmpeg_job_output_samples(const TfFfmpegJob *job) {
  return job ? job->output_samples : 0;
}

int tf_ffmpeg_render(TfFfmpegJob *job, const TfFfmpegRenderRequest *request) {
  if (!job || !request || !request->input_path || !request->output_path ||
      !request->output_format || !tf_encoder_name(request->output_format) ||
      !isfinite(request->pitch_cents) || fabs(request->pitch_cents) > 4800.0) {
    return AVERROR(EINVAL);
  }
  memset(job->error, 0, sizeof(job->error));
  job->output_sample_rate = 0;
  job->output_channels = 0;
  job->output_samples = 0;
  job->request = request;
  TfPipeline pipeline = {0};
  if (tf_cancelled(job)) {
    int cancelled = AVERROR_EXIT;
    tf_set_error(job, "cancelled", cancelled);
    job->request = NULL;
    return cancelled;
  }
  int result = tf_open_input(job, &pipeline);
  if (result < 0) { tf_set_error(job, tf_cancelled(job) ? "cancelled" : "open input", result); goto done; }
  pipeline.last_progress = 10;
  tf_progress(job, 10);
  result = tf_open_output(job, &pipeline);
  if (result < 0) { tf_set_error(job, tf_cancelled(job) ? "cancelled" : "open output", result); goto done; }
  job->output_sample_rate = pipeline.encoder->sample_rate;
  job->output_channels = pipeline.encoder->ch_layout.nb_channels;
  result = tf_open_filters(job, &pipeline);
  if (result < 0) { tf_set_error(job, tf_cancelled(job) ? "cancelled" : "configure audio filters", result); goto done; }
  pipeline.packet = av_packet_alloc();
  pipeline.decoded = av_frame_alloc();
  pipeline.filtered = av_frame_alloc();
  if (!pipeline.packet || !pipeline.decoded || !pipeline.filtered) {
    result = AVERROR(ENOMEM); tf_set_error(job, "allocate bounded frames", result); goto done;
  }
  while ((result = av_read_frame(pipeline.input, pipeline.packet)) >= 0) {
    if (tf_cancelled(job)) { result = AVERROR_EXIT; break; }
    if (pipeline.packet->stream_index == pipeline.input_stream) {
      tf_packet_progress(job, &pipeline, pipeline.packet);
      result = tf_decode_packet(job, &pipeline, pipeline.packet);
      if (result < 0) break;
    }
    av_packet_unref(pipeline.packet);
  }
  if (result == AVERROR_EOF) result = tf_decode_packet(job, &pipeline, NULL);
  if (result >= 0) result = av_buffersrc_add_frame_flags(pipeline.source, NULL, 0);
  if (result >= 0) result = tf_drain_filters(job, &pipeline);
  if (result >= 0) result = tf_encode_frame(&pipeline, NULL);
  if (result >= 0) result = av_write_trailer(pipeline.output);
  if (result < 0) tf_set_error(job, tf_cancelled(job) ? "cancelled" : "render audio", result);
  else {
    job->output_samples = pipeline.encoded_samples;
    tf_progress(job, 100);
  }
done:
  tf_close(&pipeline);
  job->request = NULL;
  return result;
}
