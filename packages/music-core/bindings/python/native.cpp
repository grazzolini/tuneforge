#include "tuneforge/music_core.h"
#include <pybind11/pybind11.h>
#include <stdexcept>

namespace py = pybind11;
PYBIND11_MODULE(_native, module) {
  module.def("api_version", &tf_music_core_api_version);
  module.def("abi_version", &tf_music_core_abi_version);
  module.def("schema_version", &tf_music_core_schema_version);
  module.def("corpus_version", &tf_music_core_corpus_version);
  module.def("call_json", [](const std::string &request) {
    TfMusicBuffer output{};
    const auto status =
        tf_music_core_call(reinterpret_cast<const uint8_t *>(request.data()),
                           request.size(), &output);
    std::string result;
    try {
      if (output.data)
        result.assign(reinterpret_cast<const char *>(output.data),
                      output.length);
    } catch (...) {
      tf_music_core_buffer_free(&output);
      throw;
    }
    tf_music_core_buffer_free(&output);
    if (status != TF_MUSIC_OK)
      throw py::value_error(result.empty() ? "music-core allocation failure"
                                           : result);
    return result;
  });
}
