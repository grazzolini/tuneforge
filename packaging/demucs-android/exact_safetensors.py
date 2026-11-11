"""Constrained reader for one verified F16 safetensors checkpoint; never pickle."""
import hashlib
import json
import struct
from pathlib import Path

EXPECTED = 'd2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411'


def tensors(path):
    import numpy as np
    import torch
    path = Path(path)
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            digest.update(block)
        if digest.hexdigest() != EXPECTED:
            raise ValueError('Exact vetted checkpoint SHA-256 mismatch')
        file_size = f.tell()
        f.seek(0)
        prefix = f.read(8)
        if len(prefix) != 8:
            raise ValueError('Truncated safetensors header')
        header_size, = struct.unpack('<Q', prefix)
        if header_size > 1024 * 1024:
            raise ValueError('Unbounded safetensors header')
        encoded_header = f.read(header_size)
        if len(encoded_header) != header_size:
            raise ValueError('Truncated safetensors header')
        header = json.loads(encoded_header)
        if not isinstance(header, dict) or not isinstance(header.get('__metadata__'), dict):
            raise ValueError('Invalid safetensors header')
        entries = [(key, value) for key, value in header.items() if key != '__metadata__']
        for _, descriptor in entries:
            if not isinstance(descriptor, dict) or set(descriptor) != {'dtype', 'shape', 'data_offsets'}:
                raise ValueError('Invalid tensor descriptor')
            offsets = descriptor['data_offsets']
            if not isinstance(offsets, list) or len(offsets) != 2 or any(type(offset) is not int for offset in offsets):
                raise ValueError('Invalid tensor offsets')
            if not isinstance(descriptor['shape'], list):
                raise ValueError('Invalid tensor shape')
        result = {}
        base = 8 + header_size
        cursor = 0
        for key, descriptor in sorted(entries, key=lambda kv: kv[1]['data_offsets'][0]):
            start, end = descriptor['data_offsets']
            shape = descriptor['shape']
            count = 1
            for size in shape:
                if type(size) is not int or size < 0:
                    raise ValueError('Invalid tensor shape')
                count *= size
            if descriptor['dtype'] != 'F16' or start != cursor or end - start != 2 * count:
                raise ValueError('Invalid tensor span or dtype')
            f.seek(base + start)
            data = f.read(end - start)
            if len(data) != end - start:
                raise ValueError('Truncated tensor')
            array = np.frombuffer(data, dtype='<f2').reshape(shape).copy()
            result[key] = torch.from_numpy(array)
            cursor = end
        if base + cursor != file_size:
            raise ValueError('Trailing or omitted tensor bytes')
    return header['__metadata__'], result


def load_model(path):
    from demucs_infer.htdemucs import HTDemucs
    from metadata_decode import _decode_metadata_json
    metadata, state = tensors(path)
    if set(metadata) != {'klass', 'args', 'kwargs'} or metadata['klass'] != 'demucs.htdemucs.HTDemucs':
        raise ValueError('Unsupported construction')
    args = _decode_metadata_json(metadata['args'], 'args')
    kwargs = _decode_metadata_json(metadata['kwargs'], 'kwargs')
    if not isinstance(args, list) or not isinstance(kwargs, dict):
        raise ValueError('Unsupported constructor argument containers')
    model = HTDemucs(*args, **kwargs)
    model.load_state_dict(state, strict=True)
    return model
