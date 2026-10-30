#pragma once

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace tuneforge {
// A bounded JSON value for the core's data-only contract; no platform
// dependencies.
class Value {
public:
  using Array = std::vector<Value>;
  using Object = std::map<std::string, Value>;
  std::variant<std::nullptr_t, bool, double, std::string, Array, Object> value;
  std::vector<std::string> insertion_keys;
  bool integer_token_kind = false;
  bool preserve_numeric_kind = false;
  std::string numeric_token;
  Value() : value(nullptr) {}
  Value(std::nullptr_t) : value(nullptr) {}
  Value(bool v) : value(v) {}
  Value(int v)
      : value(double(v)), integer_token_kind(true),
        numeric_token(std::to_string(v)) {}
  Value(std::size_t v)
      : value(double(v)), integer_token_kind(true),
        numeric_token(std::to_string(v)) {}
  Value(double v) : value(v) {
    if (!std::isfinite(v))
      throw std::invalid_argument("nonfinite-json");
  }
  Value(const char *v) : value(std::string(v)) {}
  Value(std::string v) : value(std::move(v)) {}
  Value(Array v) : value(std::move(v)) {}
  Value(Object v) : value(std::move(v)) {
    for (const auto &entry : o())
      insertion_keys.push_back(entry.first);
  }
  Value(std::initializer_list<std::pair<const std::string, Value>> pairs)
      : value(Object(pairs)) {
    for (const auto &entry : pairs)
      if (std::find(insertion_keys.begin(), insertion_keys.end(),
                    entry.first) == insertion_keys.end())
        insertion_keys.push_back(entry.first);
  }
  static Value array(Array values = {}) { return Value(std::move(values)); }
  bool null() const { return std::holds_alternative<std::nullptr_t>(value); }
  bool number() const { return std::holds_alternative<double>(value); }
  bool string() const { return std::holds_alternative<std::string>(value); }
  bool object() const { return std::holds_alternative<Object>(value); }
  bool integer_kind() const { return number() && integer_token_kind; }
  std::optional<std::int64_t> as_i64() const {
    if (!integer_kind())
      return std::nullopt;
    if (!numeric_token.empty()) {
      std::int64_t result;
      const auto parsed =
          std::from_chars(numeric_token.data(),
                          numeric_token.data() + numeric_token.size(), result);
      if (parsed.ec != std::errc{} ||
          parsed.ptr != numeric_token.data() + numeric_token.size())
        return std::nullopt;
      return result;
    }
    const double number = d();
    if (number < -9223372036854775808.0 || number >= 9223372036854775808.0)
      return std::nullopt;
    return static_cast<std::int64_t>(number);
  }
  void canonicalize_js_numbers() {
    if (number()) {
      preserve_numeric_kind = false;
      numeric_token.clear();
      integer_token_kind = std::floor(d()) == d();
    } else if (object()) {
      for (auto &entry : std::get<Object>(value))
        entry.second.canonicalize_js_numbers();
    } else if (std::holds_alternative<Array>(value)) {
      for (auto &entry : a())
        entry.canonicalize_js_numbers();
    }
  }
  int n() const {
    const double number = std::get<double>(value);
    if (number < std::numeric_limits<int>::min() ||
        number > std::numeric_limits<int>::max())
      throw std::invalid_argument("integer-out-of-range");
    return int(number);
  }
  double d() const { return std::get<double>(value); }
  bool b() const { return std::get<bool>(value); }
  const std::string &s() const { return std::get<std::string>(value); }
  const Array &a() const { return std::get<Array>(value); }
  Array &a() { return std::get<Array>(value); }
  const Object &o() const { return std::get<Object>(value); }
  const Value &operator[](const std::string &key) const {
    static const Value empty;
    if (!object())
      return empty;
    auto it = o().find(key);
    return it == o().end() ? empty : it->second;
  }
  Value &operator[](const std::string &key) {
    if (null())
      value = Object{};
    if (!o().count(key))
      insertion_keys.push_back(key);
    return std::get<Object>(value)[key];
  }
  std::vector<std::string> ordered_keys() const {
    if (!object())
      return {};
    std::vector<std::pair<std::uint32_t, std::string>> indices;
    std::vector<std::string> names;
    for (const auto &key : insertion_keys) {
      bool indexed = !key.empty() && (key.size() == 1 || key[0] != '0');
      std::uint64_t number = 0;
      for (unsigned char c : key) {
        if (c < '0' || c > '9' || number > 4294967294ULL) {
          indexed = false;
          break;
        }
        number = number * 10 + c - '0';
      }
      if (indexed && number <= 4294967294ULL)
        indices.emplace_back(std::uint32_t(number), key);
      else
        names.push_back(key);
    }
    std::sort(indices.begin(), indices.end());
    std::vector<std::string> out;
    for (const auto &entry : indices)
      out.push_back(entry.second);
    out.insert(out.end(), names.begin(), names.end());
    return out;
  }
  bool operator==(const Value &other) const { return value == other.value; }
  bool operator!=(const Value &other) const { return !(*this == other); }
  std::string dump() const {
    if (null())
      return "null";
    if (std::holds_alternative<bool>(value))
      return b() ? "true" : "false";
    if (number()) {
      if (preserve_numeric_kind && !integer_token_kind && d() == 0)
        return std::signbit(d()) ? "-0.0" : "0.0";
      if (d() == 0)
        return "0";
      if (integer_token_kind && !numeric_token.empty())
        return numeric_token;
      std::ostringstream stream;
      stream << std::setprecision(17) << d();
      auto text = stream.str();
      if (preserve_numeric_kind && !integer_token_kind &&
          text.find_first_of(".eE") == std::string::npos)
        text += ".0";
      return text;
    }
    if (string()) {
      std::string out = "\"";
      for (unsigned char c : s()) {
        if (c == '"' || c == '\\') {
          out += '\\';
          out += char(c);
        } else if (c < 32) {
          const char *hex = "0123456789abcdef";
          out += "\\u00";
          out += hex[c >> 4];
          out += hex[c & 15];
        } else
          out += char(c);
      }
      return out + '"';
    }
    std::string out = object() ? "{" : "[";
    bool first = true;
    if (object()) {
      for (const auto &key : ordered_keys()) {
        if (!first)
          out += ',';
        first = false;
        out += Value(key).dump() + ':' + (*this)[key].dump();
      }
    } else {
      for (const auto &entry : a()) {
        if (!first)
          out += ',';
        first = false;
        out += entry.dump();
      }
    }
    return out + (object() ? '}' : ']');
  }
};
using J = Value;
inline int num(const J &value, const std::string &key, int fallback = 0) {
  return value[key].number() ? value[key].n() : fallback;
}
inline std::string str(const J &value, const std::string &key,
                       const std::string &fallback = "") {
  return value[key].string() ? value[key].s() : fallback;
}
inline bool flag(const J &value, const std::string &key,
                 bool fallback = false) {
  return value[key].null() ? fallback : value[key].b();
}
} // namespace tuneforge
