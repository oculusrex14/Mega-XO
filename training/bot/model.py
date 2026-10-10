"""Compact original policy/value CNN. No pretrained language backbone or downloaded weights."""
from __future__ import annotations
import torch
from torch import nn
ENCODING_VERSION = 'planes8-v1'

class Residual(nn.Module):
    def __init__(self, width: int) -> None:
        super().__init__()
        self.layers = nn.Sequential(nn.Conv2d(width, width, 3, padding=1), nn.ReLU(), nn.Conv2d(width, width, 3, padding=1))
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.relu(x + self.layers(x))

class TinyPolicyValue(nn.Module):
    def __init__(self, width: int = 64, blocks: int = 4) -> None:
        super().__init__()
        if width not in (48, 64, 96, 128) or not 1 <= blocks <= 6:
            raise ValueError('UNSUPPORTED_MODEL_CONFIG')
        self.config = {'width': width, 'blocks': blocks, 'encodingVersion': ENCODING_VERSION}
        self.trunk = nn.Sequential(nn.Conv2d(8, width, 3, padding=1), nn.ReLU(), *[Residual(width) for _ in range(blocks)])
        self.policy = nn.Conv2d(width, 1, 1)
        self.value = nn.Sequential(nn.Conv2d(width, 8, 1), nn.ReLU(), nn.Flatten(), nn.Linear(648, 64), nn.ReLU(), nn.Linear(64, 1), nn.Tanh())
        indices = [(b // 3 * 3 + c // 3) * 9 + b % 3 * 3 + c % 3 for b in range(9) for c in range(9)]
        self.register_buffer('action_to_spatial', torch.tensor(indices, dtype=torch.int64))
    def forward(self, planes: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        x = self.trunk(planes)
        logits = self.policy(x).flatten(1).index_select(1, self.action_to_spatial)
        return logits, self.value(x)

def masked_loss(logits: torch.Tensor, values: torch.Tensor, mask: torch.Tensor, policy: torch.Tensor, outcomes: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    if not torch.all(mask.any(dim=1)) or not torch.isfinite(logits).all():
        raise ValueError('INVALID_TRAINING_OUTPUT_OR_MASK')
    log_prob = torch.log_softmax(logits.masked_fill(~mask, -1e9), dim=1)
    return -(policy * log_prob).sum(1).mean(), (values.flatten() - outcomes).square().mean()
