#include "tuneforge/music_core.h"

int main(void) {
  TfMusicBuffer buffer = {0};
  tf_music_core_buffer_free(&buffer);
  return tf_music_core_abi_version() == 1 && buffer.data == 0 &&
                 buffer.length == 0
             ? 0
             : 1;
}
