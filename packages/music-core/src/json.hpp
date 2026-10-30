#pragma once
#include "value.hpp"
namespace tuneforge {
inline Value parse_json(const std::string &text) {
  struct Parser {
    const std::string &text;
    std::size_t pos = 0;
    void ws() {
      while (pos < text.size() && (text[pos] == ' ' || text[pos] == '\n' ||
                                   text[pos] == '\r' || text[pos] == '\t'))
        ++pos;
    }
    char take() {
      if (pos >= text.size())
        throw std::invalid_argument("truncated-json");
      return text[pos++];
    }
    void expect(char c) {
      if (take() != c)
        throw std::invalid_argument("invalid-json-token");
    }
    unsigned hex() {
      unsigned result = 0;
      for (int i = 0; i < 4; ++i) {
        char c = take();
        int d = c >= '0' && c <= '9'   ? c - '0'
                : c >= 'a' && c <= 'f' ? c - 'a' + 10
                : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                       : -1;
        if (d < 0)
          throw std::invalid_argument("invalid-json-unicode");
        result = result * 16 + unsigned(d);
      }
      return result;
    }
    static void utf8(std::string &s, unsigned cp) {
      if (cp < 0x80)
        s += char(cp);
      else if (cp < 0x800) {
        s += char(0xc0 | (cp >> 6));
        s += char(0x80 | (cp & 63));
      } else if (cp < 0x10000) {
        s += char(0xe0 | (cp >> 12));
        s += char(0x80 | ((cp >> 6) & 63));
        s += char(0x80 | (cp & 63));
      } else {
        s += char(0xf0 | (cp >> 18));
        s += char(0x80 | ((cp >> 12) & 63));
        s += char(0x80 | ((cp >> 6) & 63));
        s += char(0x80 | (cp & 63));
      }
    }
    std::string string() {
      expect('"');
      std::string out;
      for (;;) {
        unsigned char c = take();
        if (c == '"')
          return out;
        if (c < 32)
          throw std::invalid_argument("invalid-json-string");
        if (c != '\\') {
          if (c >= 0x80) {
            const int continuation = c >= 0xc2 && c <= 0xdf   ? 1
                                     : c >= 0xe0 && c <= 0xef ? 2
                                     : c >= 0xf0 && c <= 0xf4 ? 3
                                                              : -1;
            if (continuation < 0)
              throw std::invalid_argument("invalid-json-utf8");
            unsigned cp = c & (continuation == 1   ? 31
                               : continuation == 2 ? 15
                                                   : 7);
            out += char(c);
            for (int i = 0; i < continuation; ++i) {
              const unsigned char next = take();
              if ((next & 0xc0) != 0x80)
                throw std::invalid_argument("invalid-json-utf8");
              cp = (cp << 6) | (next & 63);
              out += char(next);
            }
            const unsigned minimum = continuation == 1   ? 0x80
                                     : continuation == 2 ? 0x800
                                                         : 0x10000;
            if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
              throw std::invalid_argument("invalid-json-utf8");
          } else
            out += char(c);
          continue;
        }
        char e = take();
        if (e == '"' || e == '\\' || e == '/')
          out += e;
        else if (e == 'b')
          out += '\b';
        else if (e == 'f')
          out += '\f';
        else if (e == 'n')
          out += '\n';
        else if (e == 'r')
          out += '\r';
        else if (e == 't')
          out += '\t';
        else if (e == 'u') {
          unsigned cp = hex();
          if (cp >= 0xd800 && cp <= 0xdbff) {
            expect('\\');
            expect('u');
            unsigned low = hex();
            if (low < 0xdc00 || low > 0xdfff)
              throw std::invalid_argument("invalid-json-surrogate");
            cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
          } else if (cp >= 0xdc00 && cp <= 0xdfff)
            throw std::invalid_argument("invalid-json-surrogate");
          utf8(out, cp);
        } else
          throw std::invalid_argument("invalid-json-escape");
      }
    }
    Value read(int depth) {
      if (depth > 64)
        throw std::invalid_argument("json-depth");
      ws();
      if (pos >= text.size())
        throw std::invalid_argument("empty-json");
      char c = text[pos];
      if (c == '"')
        return Value(string());
      if (c == '{' || c == '[') {
        ++pos;
        Value out = c == '{' ? Value(Value::Object{}) : Value::array();
        ws();
        char end = c == '{' ? '}' : ']';
        if (pos < text.size() && text[pos] == end) {
          ++pos;
          return out;
        }
        for (;;) {
          if (c == '{') {
            ws();
            auto key = string();
            ws();
            expect(':');
            if (out.o().count(key))
              throw std::invalid_argument("duplicate-json-key");
            out[key] = read(depth + 1);
          } else
            out.a().push_back(read(depth + 1));
          ws();
          char delimiter = take();
          if (delimiter == end)
            return out;
          if (delimiter != ',')
            throw std::invalid_argument("invalid-json-delimiter");
        }
      }
      for (const auto &literal :
           {std::string("null"), std::string("true"), std::string("false")})
        if (text.compare(pos, literal.size(), literal) == 0) {
          pos += literal.size();
          return literal == "null" ? Value() : Value(literal == "true");
        }
      std::size_t start = pos;
      if (text[pos] == '-')
        ++pos;
      if (pos >= text.size() || text[pos] < '0' || text[pos] > '9')
        throw std::invalid_argument("invalid-json-number");
      if (text[pos] == '0')
        ++pos;
      else
        while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9')
          ++pos;
      for (char marker : {'.', 'e'}) {
        if (pos < text.size() &&
            (text[pos] == marker || (marker == 'e' && text[pos] == 'E'))) {
          ++pos;
          if (marker == 'e' && pos < text.size() &&
              (text[pos] == '+' || text[pos] == '-'))
            ++pos;
          auto digits = pos;
          while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9')
            ++pos;
          if (digits == pos)
            throw std::invalid_argument("invalid-json-number");
        }
      }
      const auto token = text.substr(start, pos - start);
      auto result = Value(std::stod(token));
      result.integer_token_kind =
          token.find_first_of(".eE") == std::string::npos;
      result.preserve_numeric_kind = true;
      result.numeric_token = token;
      return result;
    }
  } parser{text};
  auto result = parser.read(0);
  parser.ws();
  if (parser.pos != text.size())
    throw std::invalid_argument("trailing-json");
  return result;
}
} // namespace tuneforge
