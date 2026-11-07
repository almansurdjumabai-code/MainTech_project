"""Записи звонков. audio_url организаторов — HTML-страница плеера, внутри <source src> с mp3-ссылкой,
которая живёт ~1 час (подписанный SAS). Поэтому достаём свежую ссылку при запросе и кэшируем ненадолго."""
from __future__ import annotations

import html
import re
import time
from urllib.parse import parse_qs, urlsplit

import httpx

_SRC = re.compile(r"<source[^>]+src=\"([^\"]+)\"", re.IGNORECASE)
_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 40 * 60  # ссылка организаторов живёт ~60 мин


class AudioError(RuntimeError):
    pass


def resolve(player_url: str) -> dict:
    now = time.time()
    hit = _CACHE.get(player_url)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    try:
        resp = httpx.get(player_url, timeout=30, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise AudioError(f"player page unreachable: {type(exc).__name__}") from exc
    if resp.status_code != 200:
        raise AudioError(f"player page HTTP {resp.status_code}")
    ctype = resp.headers.get("content-type", "")
    if ctype.startswith("audio/"):
        info = {"audio_src": player_url, "content_type": ctype, "expires_at": None}
    else:
        m = _SRC.search(resp.text)
        if not m:
            raise AudioError("no <source src> in player page")
        src = html.unescape(m.group(1))
        q = parse_qs(urlsplit(src).query)
        info = {"audio_src": src, "content_type": "audio/mpeg", "expires_at": (q.get("se") or [None])[0]}
    _CACHE[player_url] = (now, info)
    return info
