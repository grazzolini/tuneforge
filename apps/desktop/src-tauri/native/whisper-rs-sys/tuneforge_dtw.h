#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace tuneforge {

struct DtwPoint {
    int64_t token;
    int64_t frame;
};

struct DtwBoundaryValidation {
    size_t expected;
    size_t emitted;
    size_t missing;
    size_t reversed;
    int64_t first_jump;

    bool valid() const {
        return emitted == expected && missing == 0 && reversed == 0;
    }
};

inline DtwBoundaryValidation validate_dtw_boundaries(
        const std::vector<int64_t> & boundaries,
        size_t text_token_count) {
    DtwBoundaryValidation validation {
        text_token_count + 1,
        boundaries.size(),
        text_token_count + 1 > boundaries.size()
                ? text_token_count + 1 - boundaries.size()
                : 0,
        0,
        boundaries.empty() ? -1 : boundaries.front(),
    };
    for (size_t index = 0; index < boundaries.size(); ++index) {
        if (boundaries[index] < 0) {
            ++validation.missing;
        }
        if (index > 0 && boundaries[index - 1] >= 0 && boundaries[index] >= 0 &&
                boundaries[index] < boundaries[index - 1]) {
            ++validation.reversed;
        }
    }
    return validation;
}

template <typename ValueAt>
std::vector<DtwPoint> dtw_path(int64_t token_count, int64_t frame_count, ValueAt value_at) {
    const auto offset = [frame_count](int64_t token, int64_t frame) {
        return static_cast<size_t>(token * (frame_count + 1) + frame);
    };
    std::vector<double> cost(
        static_cast<size_t>((token_count + 1) * (frame_count + 1)),
        std::numeric_limits<double>::infinity());
    std::vector<int32_t> trace(cost.size(), -1);
    cost[offset(0, 0)] = 0.0;

    for (int64_t frame = 1; frame <= frame_count; ++frame) {
        for (int64_t token = 1; token <= token_count; ++token) {
            const double diagonal = cost[offset(token - 1, frame - 1)];
            const double vertical = cost[offset(token - 1, frame)];
            const double horizontal = cost[offset(token, frame - 1)];
            double previous;
            int32_t direction;
            if (diagonal < vertical && diagonal < horizontal) {
                previous = diagonal;
                direction = 0;
            } else if (vertical < diagonal && vertical < horizontal) {
                previous = vertical;
                direction = 1;
            } else {
                previous = horizontal;
                direction = 2;
            }
            cost[offset(token, frame)] =
                    static_cast<double>(value_at(token - 1, frame - 1)) + previous;
            trace[offset(token, frame)] = direction;
        }
    }

    for (int64_t frame = 0; frame <= frame_count; ++frame) {
        trace[offset(0, frame)] = 2;
    }
    for (int64_t token = 0; token <= token_count; ++token) {
        trace[offset(token, 0)] = 1;
    }
    std::vector<DtwPoint> path;
    int64_t token = token_count;
    int64_t frame = frame_count;
    while (token > 0 || frame > 0) {
        path.push_back({ token - 1, frame - 1 });
        const int32_t direction = trace[offset(token, frame)];
        if (direction == 0) {
            --token;
            --frame;
        } else if (direction == 1) {
            --token;
        } else {
            --frame;
        }
    }
    std::reverse(path.begin(), path.end());
    return path;
}

inline size_t attention_offset(
        int64_t token,
        int64_t frame,
        int64_t head,
        int64_t token_count,
        int64_t frame_count) {
    return static_cast<size_t>(token + frame * token_count + head * token_count * frame_count);
}

inline bool renormalize_clipped_attention(
        float * values,
        int64_t token_count,
        int64_t frame_count,
        int64_t head_count) {
    if (values == nullptr || token_count <= 0 || frame_count <= 0 || head_count <= 0) {
        return false;
    }
    // OpenAI truncates raw QK scores to the usable audio frames before softmax.
    // Renormalizing the already-softmaxed slice is mathematically equivalent.
    for (int64_t head = 0; head < head_count; ++head) {
        for (int64_t token = 0; token < token_count; ++token) {
            double total = 0.0;
            for (int64_t frame = 0; frame < frame_count; ++frame) {
                total += values[attention_offset(token, frame, head, token_count, frame_count)];
            }
            if (!(total > 0.0) || !std::isfinite(total)) {
                return false;
            }
            for (int64_t frame = 0; frame < frame_count; ++frame) {
                const size_t offset = attention_offset(token, frame, head, token_count, frame_count);
                values[offset] = static_cast<float>(values[offset] / total);
            }
        }
    }
    return true;
}

inline bool standardize_attention_tokens(
        float * values,
        int64_t token_count,
        int64_t frame_count,
        int64_t head_count) {
    if (values == nullptr || token_count <= 0 || frame_count <= 0 || head_count <= 0) {
        return false;
    }
    // torch.std_mean(..., unbiased=False) followed by division does not add an
    // epsilon. Normalize each head/frame across text tokens before filtering.
    for (int64_t head = 0; head < head_count; ++head) {
        for (int64_t frame = 0; frame < frame_count; ++frame) {
            float sum = 0.0f;
            for (int64_t token = 0; token < token_count; ++token) {
                sum += values[attention_offset(token, frame, head, token_count, frame_count)];
            }
            const float mean = sum / static_cast<float>(token_count);
            float variance = 0.0f;
            for (int64_t token = 0; token < token_count; ++token) {
                const float centered =
                        values[attention_offset(token, frame, head, token_count, frame_count)] - mean;
                variance += centered * centered;
            }
            variance /= static_cast<float>(token_count);
            if (!(variance > 0.0f) || !std::isfinite(variance)) {
                return false;
            }
            const float scale = 1.0f / std::sqrt(variance);
            for (int64_t token = 0; token < token_count; ++token) {
                const size_t offset = attention_offset(token, frame, head, token_count, frame_count);
                values[offset] = (values[offset] - mean) * scale;
            }
        }
    }
    return true;
}

inline bool normalize_clipped_attention(
        float * values,
        int64_t token_count,
        int64_t frame_count,
        int64_t head_count) {
    return renormalize_clipped_attention(values, token_count, frame_count, head_count) &&
            standardize_attention_tokens(values, token_count, frame_count, head_count);
}

}  // namespace tuneforge
