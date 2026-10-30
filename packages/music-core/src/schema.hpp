#pragma once
#include "operation_schema.hpp"
#include "value.hpp"
#include <set>

namespace tuneforge {
inline void require_schema_vocabulary(const J &schema) {
  static const std::set<std::string> keywords{
      "$schema",     "$id",        "$ref",     "title",
      "description", "$defs",      "oneOf",    "anyOf",
      "type",        "properties", "required", "additionalProperties",
      "items",       "enum",       "const"};
  if (!schema.object())
    throw std::invalid_argument("invalid-owned-schema");
  for (const auto &entry : schema.o()) {
    if (!keywords.count(entry.first))
      throw std::invalid_argument("unsupported-owned-schema-keyword");
    if (entry.first == "properties" || entry.first == "$defs") {
      for (const auto &property : entry.second.o())
        require_schema_vocabulary(property.second);
    } else if (entry.first == "oneOf" || entry.first == "anyOf") {
      for (const auto &branch : entry.second.a())
        require_schema_vocabulary(branch);
    } else if (entry.first == "items" ||
               (entry.first == "additionalProperties" && entry.second.object()))
      require_schema_vocabulary(entry.second);
    else if (entry.first == "type") {
      static const std::set<std::string> types{
          "object", "array", "number", "integer", "string", "boolean", "null"};
      if (!entry.second.string() || !types.count(entry.second.s()))
        throw std::invalid_argument("unsupported-owned-schema-type");
    }
  }
}
inline const J &operation_schema() {
  static const J schema = [] {
    auto value = embedded_operation_schema();
    require_schema_vocabulary(value);
    return value;
  }();
  return schema;
}

// Shared interpreter for the explicit JSON Schema vocabulary used by API 1.
// Unsupported reference forms fail closed; no remote schema lookup is
// performed.
inline bool matches_schema(const J &input, const J &schema, int depth = 0) {
  if (depth > 64 || !schema.object())
    return false;
  const auto &reference = schema["$ref"];
  if (!reference.null()) {
    const std::string prefix = "#/$defs/";
    if (!reference.string() ||
        reference.s().compare(0, prefix.size(), prefix) != 0)
      return false;
    const auto &target =
        operation_schema()["$defs"][reference.s().substr(prefix.size())];
    return target.object() && matches_schema(input, target, depth + 1);
  }
  if (!schema["oneOf"].null()) {
    int matches = 0;
    for (const auto &branch : schema["oneOf"].a())
      if (matches_schema(input, branch, depth + 1))
        ++matches;
    if (matches != 1)
      return false;
  }
  if (!schema["anyOf"].null()) {
    bool matches = false;
    for (const auto &branch : schema["anyOf"].a())
      if (matches_schema(input, branch, depth + 1))
        matches = true;
    if (!matches)
      return false;
  }
  if (schema.o().count("const") && input != schema["const"])
    return false;
  if (!schema["enum"].null()) {
    bool matches = false;
    for (const auto &candidate : schema["enum"].a())
      if (input == candidate)
        matches = true;
    if (!matches)
      return false;
  }
  const auto type = str(schema, "type");
  if ((!type.empty() && type == "object" && !input.object()) ||
      (type == "array" && !std::holds_alternative<J::Array>(input.value)) ||
      (type == "number" && !input.number()) ||
      (type == "integer" &&
       (!input.number() || std::floor(input.d()) != input.d())) ||
      (type == "string" && !input.string()) ||
      (type == "boolean" && !std::holds_alternative<bool>(input.value)) ||
      (type == "null" && !input.null()))
    return false;
  if (input.object()) {
    if (!schema["required"].null())
      for (const auto &key : schema["required"].a())
        if (!input.o().count(key.s()))
          return false;
    const auto &properties = schema["properties"];
    for (const auto &entry : input.o()) {
      if (properties.object() && properties.o().count(entry.first)) {
        if (!matches_schema(entry.second, properties[entry.first], depth + 1))
          return false;
      } else {
        const auto &additional = schema["additionalProperties"];
        if (std::holds_alternative<bool>(additional.value) && !additional.b())
          return false;
        if (additional.object() &&
            !matches_schema(entry.second, additional, depth + 1))
          return false;
      }
    }
  }
  if (std::holds_alternative<J::Array>(input.value) && !schema["items"].null())
    for (const auto &item : input.a())
      if (!matches_schema(item, schema["items"], depth + 1))
        return false;
  return true;
}
} // namespace tuneforge
