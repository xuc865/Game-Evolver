from __future__ import annotations

from typing import Any

from .base import BenchmarkAdapter
from .gcbench import GameCraftBenchAdapter
from .gdbench import GameDevBenchAdapter
from .swebench import SWEBenchAdapter
from .nl2repo import NL2RepoAdapter
from .terminalbench import TerminalBenchAdapter
from .weavebench import WeaveBenchAdapter
from .verigame import VerigameAdapter
from .vgamegym import VGameGymAdapter
from .taubench import TauBenchAdapter
from .tinymmo import TinyMMOAdapter
from .ksre import KSREAdapter

_ADAPTERS: dict[str, type[BenchmarkAdapter]] = {
    "gcbench": GameCraftBenchAdapter,
    "gdbench": GameDevBenchAdapter,
    "swebench": SWEBenchAdapter,
    "nl2repo": NL2RepoAdapter,
    "terminalbench": TerminalBenchAdapter,
    "weavebench": WeaveBenchAdapter,
    "verigame": VerigameAdapter,
    "vgamegym": VGameGymAdapter,
    "taubench": TauBenchAdapter,
    "tinymmo": TinyMMOAdapter,
    "ksre": KSREAdapter,
}


def load_adapter(adapter_id: str, options: dict[str, Any] | None = None) -> BenchmarkAdapter:
    factory = _ADAPTERS.get(adapter_id)
    if factory is None:
        raise ValueError(f"unsupported benchmark adapter: {adapter_id}")
    return factory(dict(options or {}))


__all__ = [
    "BenchmarkAdapter",
    "GameCraftBenchAdapter",
    "GameDevBenchAdapter",
    "SWEBenchAdapter",
    "NL2RepoAdapter",
    "TerminalBenchAdapter",
    "WeaveBenchAdapter",
    "VerigameAdapter",
    "VGameGymAdapter",
    "TauBenchAdapter",
    "TinyMMOAdapter",
    "KSREAdapter",
    "load_adapter",
]
