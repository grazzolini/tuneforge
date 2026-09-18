#pragma once

#include <cstdint>
#include <limits>
#include <string>
#include <vector>
#include <zlib.h>

namespace tuneforge {

inline bool python_whitespace(uint32_t codepoint) {
    return (codepoint >= 0x0009 && codepoint <= 0x000d) ||
           (codepoint >= 0x001c && codepoint <= 0x0020) ||
            codepoint == 0x0085 || codepoint == 0x00a0 || codepoint == 0x1680 ||
           (codepoint >= 0x2000 && codepoint <= 0x200a) ||
            codepoint == 0x2028 || codepoint == 0x2029 || codepoint == 0x202f ||
            codepoint == 0x205f || codepoint == 0x3000;
}

inline size_t utf8_codepoint(const std::string & text, size_t offset, uint32_t & codepoint) {
    const unsigned char first = static_cast<unsigned char>(text[offset]);
    if (first < 0x80) {
        codepoint = first;
        return 1;
    }
    size_t length = 0;
    uint32_t value = 0;
    if ((first & 0xe0) == 0xc0) {
        length = 2;
        value = first & 0x1f;
    } else if ((first & 0xf0) == 0xe0) {
        length = 3;
        value = first & 0x0f;
    } else if ((first & 0xf8) == 0xf0) {
        length = 4;
        value = first & 0x07;
    } else {
        return 0;
    }
    if (offset + length > text.size()) {
        return 0;
    }
    for (size_t index = 1; index < length; ++index) {
        const unsigned char byte = static_cast<unsigned char>(text[offset + index]);
        if ((byte & 0xc0) != 0x80) {
            return 0;
        }
        value = (value << 6) | (byte & 0x3f);
    }
    if ((length == 2 && value < 0x80) ||
        (length == 3 && value < 0x800) ||
        (length == 4 && value < 0x10000) ||
        (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
        return 0;
    }
    codepoint = value;
    return length;
}

inline std::string python_decode_utf8_replace(const std::string & text) {
    std::string decoded;
    for (size_t offset = 0; offset < text.size();) {
        uint32_t value = 0;
        const size_t length = utf8_codepoint(text, offset, value);
        if (length > 0) {
            decoded.append(text, offset, length);
            offset += length;
            continue;
        }
        const unsigned char first = static_cast<unsigned char>(text[offset]);
        const size_t expected = (first >= 0xc2 && first <= 0xdf) ? 2 :
                                (first >= 0xe0 && first <= 0xef) ? 3 :
                                (first >= 0xf0 && first <= 0xf4) ? 4 : 1;
        size_t consumed = 1;
        bool invalid_second = false;
        if (expected > 1 && offset + 1 < text.size()) {
            const unsigned char second = static_cast<unsigned char>(text[offset + 1]);
            invalid_second = (first == 0xe0 && second < 0xa0) ||
                             (first == 0xed && second > 0x9f) ||
                             (first == 0xf0 && second < 0x90) ||
                             (first == 0xf4 && second > 0x8f);
        }
        if (!invalid_second) {
            while (consumed < expected && offset + consumed < text.size() &&
                   (static_cast<unsigned char>(text[offset + consumed]) & 0xc0) == 0x80) {
                ++consumed;
            }
        }
        if (invalid_second || consumed == expected) {
            consumed = 1;
        }
        decoded.append("\xEF\xBF\xBD", 3);
        offset += consumed;
    }
    return decoded;
}

inline std::string python_strip(const std::string & input) {
    const std::string text = python_decode_utf8_replace(input);
    struct CodepointSpan { size_t begin; size_t end; uint32_t value; };
    std::vector<CodepointSpan> spans;
    for (size_t offset = 0; offset < text.size();) {
        uint32_t value = 0;
        const size_t length = utf8_codepoint(text, offset, value);
        spans.push_back({ offset, offset + length, value });
        offset += length;
    }
    size_t first = 0;
    while (first < spans.size() && python_whitespace(spans[first].value)) {
        ++first;
    }
    size_t last = spans.size();
    while (last > first && python_whitespace(spans[last - 1].value)) {
        --last;
    }
    if (first == last) {
        return "";
    }
    return text.substr(spans[first].begin, spans[last - 1].end - spans[first].begin);
}

inline double compression_ratio(const std::string & input) {
    const std::string text = python_strip(input);
    uLongf compressed_size = compressBound(text.size());
    std::vector<Bytef> compressed(compressed_size);
    if (compress2(compressed.data(), &compressed_size,
                  reinterpret_cast<const Bytef *>(text.data()), text.size(),
                  Z_DEFAULT_COMPRESSION) != Z_OK || compressed_size == 0) {
        return std::numeric_limits<double>::infinity();
    }
    return static_cast<double>(text.size()) / static_cast<double>(compressed_size);
}

}  // namespace tuneforge
