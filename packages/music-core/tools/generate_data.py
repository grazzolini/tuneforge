"""Serialize owned JSON to a C++ string; interpretation stays in the shared core."""

import hashlib
import json
import sys
from pathlib import Path

source = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
text = json.dumps(source, ensure_ascii=False, separators=(",", ":"))
function_name = sys.argv[3] if len(sys.argv) > 3 else "embedded_knowledge"
delimiter = "TFM_" + hashlib.sha256(text.encode()).hexdigest()[:10]
if f'){delimiter}"' in text:
    raise ValueError("Owned data collides with its C++ raw-string delimiter")
generated = (
    '#pragma once\n#include "json.hpp"\nnamespace tuneforge { inline J '
    + function_name
    + '() { return parse_json(std::string(R"'
    + delimiter
    + "("
    + text
    + ")"
    + delimiter
    + '")); } }\n'
)
output = Path(sys.argv[2])
if not output.exists() or output.read_text(encoding="utf-8") != generated:
    output.write_text(generated, encoding="utf-8")
