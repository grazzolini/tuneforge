#ifndef TUNEFORGE_MUSIC_CORE_H
#define TUNEFORGE_MUSIC_CORE_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define TUNEFORGE_MUSIC_EXPORT __declspec(dllexport)
#else
#define TUNEFORGE_MUSIC_EXPORT __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
#define TUNEFORGE_MUSIC_NOEXCEPT noexcept
extern "C" {
#else
#define TUNEFORGE_MUSIC_NOEXCEPT
#endif

typedef enum TfMusicStatus {
  TF_MUSIC_OK = 0,
  TF_MUSIC_INVALID_ARGUMENT = 1,
  TF_MUSIC_INVALID_JSON = 2,
  TF_MUSIC_OPERATION_FAILED = 3,
  TF_MUSIC_OUT_OF_MEMORY = 4
} TfMusicStatus;

typedef struct TfMusicBuffer {
  uint8_t *data;
  size_t length;
} TfMusicBuffer;

TUNEFORGE_MUSIC_EXPORT uint32_t tf_music_core_api_version(void)
    TUNEFORGE_MUSIC_NOEXCEPT;
TUNEFORGE_MUSIC_EXPORT uint32_t tf_music_core_abi_version(void)
    TUNEFORGE_MUSIC_NOEXCEPT;
TUNEFORGE_MUSIC_EXPORT uint32_t tf_music_core_schema_version(void)
    TUNEFORGE_MUSIC_NOEXCEPT;
TUNEFORGE_MUSIC_EXPORT uint32_t tf_music_core_corpus_version(void)
    TUNEFORGE_MUSIC_NOEXCEPT;

/* Input is a length-delimited UTF-8 JSON request. No trailing NUL is required.
 * Output is core-owned UTF-8 JSON with an additional trailing NUL outside
 * length. Always release output with tf_music_core_buffer_free before reusing
 * its slot. Failure may return an error object; allocation failure leaves an
 * empty buffer. This boundary catches all C++ exceptions. It performs no
 * network or file I/O.
 */
TUNEFORGE_MUSIC_EXPORT TfMusicStatus
tf_music_core_call(const uint8_t *request, size_t request_length,
                   TfMusicBuffer *output) TUNEFORGE_MUSIC_NOEXCEPT;

/* Accepts NULL and empty buffers. Clears the pointer and length after release.
 */
TUNEFORGE_MUSIC_EXPORT void
tf_music_core_buffer_free(TfMusicBuffer *buffer) TUNEFORGE_MUSIC_NOEXCEPT;

#ifdef __cplusplus
}
#endif
#undef TUNEFORGE_MUSIC_NOEXCEPT
#undef TUNEFORGE_MUSIC_EXPORT
#endif
