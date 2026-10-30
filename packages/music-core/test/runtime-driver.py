"""Raw JSON transport only: preserve Python integer/float distinctions."""
import json
import sys
from tuneforge_music_core import _native
for line in sys.stdin:
    response = json.loads(_native.call_json('{"apiVersion":1,"schemaVersion":1,' + line.strip()[1:]))
    print(json.dumps(response["result"], ensure_ascii=False, allow_nan=False))
