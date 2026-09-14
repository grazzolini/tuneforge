import sys

import torch
import torchaudio

expected_torch = "2.13.0+cu126"
expected_torchaudio = "2.11.0+cu126"
if torch.__version__ != expected_torch:
    raise SystemExit(f"Expected torch {expected_torch} for the legacy NVIDIA profile, found {torch.__version__}.")

if torchaudio.__version__ != expected_torchaudio:
    raise SystemExit(
        f"Expected torchaudio {expected_torchaudio} for the legacy NVIDIA profile, found {torchaudio.__version__}."
    )

if torch.version.cuda != "12.6":
    raise SystemExit(f"Expected CUDA 12.6 for the legacy NVIDIA profile, found {torch.version.cuda}.")

sys.stdout.write(
    f"Verified legacy NVIDIA Torch profile: torch {torch.__version__}, "
    f"torchaudio {torchaudio.__version__}, CUDA {torch.version.cuda}\n"
)
