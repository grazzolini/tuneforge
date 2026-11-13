"""Inference subset of BS-RoFormer, adapted from MSST ea7eb9c20ea0e3f94368a30fc1654b51cdd55789.

Copyright (c) 2023 Phil Wang. MIT license. See THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Any, cast

import torch
import yaml
from einops import rearrange
from rotary_embedding_torch import RotaryEmbedding
from torch import Tensor, nn
from torch.nn import functional as F

SAMPLE_RATE = 44100
CHUNK_FRAMES = 441000
VOCAL_HEADS = ("lead-vocal", "back-vocal")


class _ConfigLoader(yaml.SafeLoader):
    """The pinned release uses the sequence-only Python tuple tag."""


def _load_tuple(loader: _ConfigLoader, node: yaml.SequenceNode) -> tuple[Any, ...]:
    return tuple(loader.construct_sequence(node, deep=True))


_ConfigLoader.add_constructor("tag:yaml.org,2002:python/tuple", _load_tuple)


class RMSNorm(nn.Module):
    def __init__(self, dim: int) -> None:
        super().__init__()
        self.scale = dim ** 0.5
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x: Tensor) -> Tensor:
        return F.normalize(x, dim=-1) * self.scale * self.gamma


def tiled_attention(q: Tensor, k: Tensor, v: Tensor) -> Tensor:
    # Independent packed batches and query rows can be tiled. Every row sees all keys.
    heads, query_count, key_count = q.shape[1], q.shape[-2], k.shape[-2]
    batch_tile = max(1, (32 * 1024 * 1024) // (heads * query_count * key_count))
    scale = q.shape[-1] ** -0.5
    outputs = []
    for lo in range(0, q.shape[0], batch_tile):
        hi = min(lo + batch_tile, q.shape[0])
        query_tile = max(1, (8 * 1024 * 1024) // ((hi - lo) * heads * key_count))
        rows = []
        for query in q[lo:hi].split(query_tile, dim=-2):
            scores = torch.einsum("b h i d, b h j d -> b h i j", query, k[lo:hi]) * scale
            attention = scores.softmax(dim=-1)
            rows.append(torch.einsum("b h i j, b h j d -> b h i d", attention, v[lo:hi]))
            del scores, attention
        outputs.append(rows[0] if len(rows) == 1 else torch.cat(rows, dim=-2))
    return outputs[0] if len(outputs) == 1 else torch.cat(outputs, dim=0)


class Attention(nn.Module):
    def __init__(self, dim: int, heads: int, dim_head: int, rotary_embed: RotaryEmbedding) -> None:
        super().__init__()
        self.heads = heads
        self.rotary_embed = rotary_embed
        inner = heads * dim_head
        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, inner * 3, bias=False)
        self.to_gates = nn.Linear(dim, heads)
        self.to_out = nn.Sequential(nn.Linear(inner, dim, bias=False))

    def forward(self, x: Tensor) -> Tensor:
        x = self.norm(x)
        q, k, v = rearrange(self.to_qkv(x), "b n (qkv h d) -> qkv b h n d", qkv=3, h=self.heads)
        q = self.rotary_embed.rotate_queries_or_keys(q)
        k = self.rotary_embed.rotate_queries_or_keys(k)
        out = tiled_attention(q, k, v)
        gates = rearrange(self.to_gates(x), "b n h -> b h n 1").sigmoid()
        return self.to_out(rearrange(out * gates, "b h n d -> b n (h d)"))


class FeedForward(nn.Module):
    def __init__(self, dim: int) -> None:
        super().__init__()
        # Keep original module indices in the checkpoint contract.
        self.net = nn.Sequential(
            RMSNorm(dim), nn.Linear(dim, dim * 4), nn.GELU(), nn.Identity(), nn.Linear(dim * 4, dim)
        )

    def forward(self, x: Tensor) -> Tensor:
        return self.net(x)


class Transformer(nn.Module):
    def __init__(self, dim: int, heads: int, dim_head: int, rotary: RotaryEmbedding) -> None:
        super().__init__()
        self.layers = nn.ModuleList([nn.ModuleList([Attention(dim, heads, dim_head, rotary), FeedForward(dim)])])

    def forward(self, x: Tensor) -> Tensor:
        attention, ff = cast(nn.ModuleList, self.layers[0])
        x = attention(x) + x
        return ff(x) + x


class BandSplit(nn.Module):
    def __init__(self, dim: int, band_dims: tuple[int, ...]) -> None:
        super().__init__()
        self.band_dims = band_dims
        self.to_features = nn.ModuleList(
            nn.Sequential(RMSNorm(size), nn.Linear(size, dim)) for size in band_dims
        )

    def forward(self, x: Tensor) -> Tensor:
        return torch.stack([
            layer(band) for band, layer in zip(x.split(self.band_dims, dim=-1), self.to_features, strict=True)
        ], dim=-2)


class MaskEstimator(nn.Module):
    def __init__(self, dim: int, band_dims: tuple[int, ...], expansion: int) -> None:
        super().__init__()
        self.to_freqs = nn.ModuleList(
            nn.Sequential(nn.Sequential(nn.Linear(dim, dim * expansion), nn.Tanh(),
                                        nn.Linear(dim * expansion, size * 2)), nn.GLU(dim=-1))
            for size in band_dims
        )

    def forward(self, x: Tensor) -> Tensor:
        return torch.cat([
            layer(band) for band, layer in zip(x.unbind(dim=-2), self.to_freqs, strict=True)
        ], dim=-1)


class MegaRoformer(nn.Module):
    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__()
        dim, heads, dim_head = (config[key] for key in ("dim", "heads", "dim_head"))
        time_rotary = RotaryEmbedding(dim=dim_head)
        freq_rotary = RotaryEmbedding(dim=dim_head)
        self.layers = nn.ModuleList(
            nn.ModuleList([Transformer(dim, heads, dim_head, time_rotary),
                           Transformer(dim, heads, dim_head, freq_rotary)])
            for _ in range(config["depth"])
        )
        self.final_norm = RMSNorm(dim)
        self.n_fft = config["stft_n_fft"]
        self.hop = config["stft_hop_length"]
        self.win_length = config["stft_win_length"]
        self.stft_kwargs = dict(
            n_fft=self.n_fft, hop_length=self.hop, win_length=self.win_length,
            normalized=config["stft_normalized"],
        )
        band_dims = tuple(4 * size for size in config["freqs_per_bands"])
        self.band_split = BandSplit(dim, band_dims)
        # Construct metadata for all native heads before pruning and loading weights.
        with torch.device("meta"):
            self.mask_estimators = nn.ModuleList(
                MaskEstimator(dim, band_dims, config["mlp_expansion_factor"])
                for _ in range(config["num_stems"])
            )

    def forward(self, raw_audio: Tensor) -> Tensor:
        device = raw_audio.device
        spectral_device = torch.device("cpu") if device.type == "mps" else device
        window = torch.hann_window(self.win_length, device=spectral_device)
        spectrum = torch.stft(raw_audio.flatten(0, 1).to(spectral_device), **self.stft_kwargs,
                              window=window, return_complex=True)
        spectrum = rearrange(torch.view_as_real(spectrum), "(b s) f t c -> b (f s) t c", s=2)
        x = self.band_split(rearrange(spectrum, "b f t c -> b t (f c)").to(device))

        for layer in self.layers:
            time_transformer, freq_transformer = cast(nn.ModuleList, layer)
            batch, time, bands, _ = x.shape
            x = time_transformer(rearrange(x, "b t f d -> (b f) t d"))
            x = rearrange(x, "(b f) t d -> (b t) f d", b=batch, f=bands)
            x = freq_transformer(x)
            x = rearrange(x, "(b t) f d -> b t f d", b=batch, t=time)

        x = self.final_norm(x)
        masks = torch.stack([estimator(x) for estimator in self.mask_estimators], dim=1)
        masks = rearrange(masks, "b n t (f c) -> b n f t c", c=2)
        masked = torch.view_as_complex(spectrum.unsqueeze(1)) * torch.view_as_complex(masks.to(spectral_device))
        masked = rearrange(masked, "b n (f s) t -> (b n s) f t", s=2)
        masked = masked.index_fill(1, torch.tensor(0, device=spectral_device), 0.)
        audio = torch.istft(masked, **self.stft_kwargs, window=window, length=raw_audio.shape[-1])
        return rearrange(audio, "(b n s) t -> b n s t", s=2, n=len(VOCAL_HEADS)).to(device)


def load_mega_roformer(checkpoint: Path, config_path: Path) -> MegaRoformer:
    config = yaml.load(config_path.read_bytes(), Loader=_ConfigLoader)
    audio, options = config["audio"], config["model"]
    names = tuple(config["training"]["instruments"])
    if (audio["chunk_size"], audio["sample_rate"], audio["num_channels"]) != (CHUNK_FRAMES, SAMPLE_RATE, 2):
        raise ValueError("Mega53 audio configuration does not match the pinned release.")
    if (
        len(set(names)) != 53 or options["num_stems"] != 53 or not options["stereo"]
        or options["linear_transformer_depth"] != 0 or options["time_transformer_depth"] != 1
        or options["freq_transformer_depth"] != 1 or options["mask_estimator_depth"] != 2
        or any(options.get(key) for key in ("use_torch_checkpoint", "use_pope", "skip_connection"))
    ):
        raise ValueError("Mega53 architecture does not match the pinned release.")
    model = MegaRoformer(options)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True, mmap=True)
    if type(state) not in {dict, OrderedDict} or len(state) != 13595:
        raise ValueError("Invalid Mega53 checkpoint tensor table.")
    expected = model.state_dict()
    if state.keys() != expected.keys():
        raise ValueError("Mega53 checkpoint tensor names do not match.")
    for name, tensor in state.items():
        if (
            type(tensor) not in {torch.Tensor, torch.nn.Parameter} or tensor.device.type != "cpu"
            or tensor.layout != torch.strided or tensor.shape != expected[name].shape
            or tensor.dtype != torch.float16
        ):
            raise ValueError("Invalid Mega53 checkpoint tensor contract.")
    indices = [names.index(name) for name in VOCAL_HEADS]
    model.mask_estimators = nn.ModuleList(model.mask_estimators[index] for index in indices)
    head_map = {f"mask_estimators.{index}.": f"mask_estimators.{native}." for index, native in enumerate(indices)}
    retained = {}
    for name in model.state_dict():
        prefix = next((prefix for prefix in head_map if name.startswith(prefix)), None)
        native_name = name.replace(prefix, head_map[prefix], 1) if prefix else name
        retained[name] = state[native_name]
    model.load_state_dict(retained, strict=True, assign=True)
    return model.float().eval()
