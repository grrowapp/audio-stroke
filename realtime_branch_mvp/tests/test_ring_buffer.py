import struct

import pytest

from realtime_session import PcmRing, RuntimeSettings


def pcm(values):
    return struct.pack(f"<{len(values)}h", *values)


def test_slice_across_chunk_boundaries():
    r = PcmRing(capacity_samples=1000)
    r.append(pcm(range(0, 10)))
    r.append(pcm(range(10, 25)))
    r.append(pcm(range(25, 30)))
    assert r.total == 30
    assert r.slice(8, 12) == pcm([8, 9, 10, 11])
    assert r.slice(0, 30) == pcm(range(30))
    assert r.slice(24, 26) == pcm([24, 25])
    assert r.slice(30, 30) == b""


def test_out_of_range_and_eviction():
    r = PcmRing(capacity_samples=20)
    for i in range(5):
        r.append(pcm([i] * 10))
    # only the newest ~20 samples are retained
    assert r.retained_start >= 20
    assert r.slice(0, 10) is None  # evicted → caller must skip preview, never fabricate
    assert r.slice(r.retained_start, r.total) is not None
    assert r.slice(r.total - 5, r.total + 1) is None


def test_odd_byte_frame_rejected():
    r = PcmRing(100)
    with pytest.raises(ValueError):
        r.append(b"\x00\x01\x02")


def test_drop_all_keeps_absolute_timeline():
    r = PcmRing(1000)
    r.append(pcm([1] * 100))
    r.drop_all()
    assert r.total == 100 and r.slice(0, 10) is None
    r.append(pcm([2] * 10))
    assert r.slice(100, 110) == pcm([2] * 10)


def test_runtime_settings_bounds():
    rs = RuntimeSettings.from_user({"silence_duration_ms": 700, "final_grace_ms": 0, "preview_enabled": False})
    assert rs.silence_duration_ms == 700 and rs.final_grace_ms == 0 and not rs.preview_enabled
    with pytest.raises(ValueError):
        RuntimeSettings.from_user({"silence_duration_ms": 50})
    with pytest.raises(ValueError):
        RuntimeSettings.from_user({"final_grace_ms": "abc"})
