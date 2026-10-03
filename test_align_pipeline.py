"""
Comprehensive test suite for the align.py canonical-first alignment engine.
"""

import os
import sys
import json
import tempfile
from pathlib import Path

# Import alignment engine from align.py
import align


def test_missing_sung_vocalizations():
    print("Testing sung vocalizations in canonical lyrics (Ooh, yeah, oh)...")
    user_lyrics = "[00:01.20]Ooh I love you yeah"
    whisper_words = [
        {"text": "Ooh", "start": 1.2, "end": 1.6, "score": 0.92},
        {"text": "I", "start": 1.7, "end": 1.9, "score": 0.98},
        {"text": "love", "start": 2.0, "end": 2.3, "score": 0.95},
        {"text": "you", "start": 2.4, "end": 2.8, "score": 0.97},
        {"text": "yeah", "start": 2.9, "end": 3.4, "score": 0.89},
    ]
    
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 10.0)
    assert len(segs) == 1
    words = [w["word"] for w in segs[0]["words"]]
    print(f"  Result words: {words}")
    assert words == ["Ooh", "I", "love", "you", "yeah"]
    assert abs(segs[0]["words"][0]["start"] - 1.2) < 1e-4
    assert abs(segs[0]["words"][4]["end"] - 3.4) < 1e-4
    print("  ✓ Passed!")


def test_missing_repeated_words():
    print("Testing repeated sung words...")
    user_lyrics = "[00:05.00]Never let go never let go"
    whisper_words = [
        {"text": "Never", "start": 5.0, "end": 5.4, "score": 0.95},
        {"text": "let", "start": 5.5, "end": 5.7, "score": 0.95},
        {"text": "go", "start": 5.8, "end": 6.1, "score": 0.95},
        {"text": "never", "start": 6.2, "end": 6.6, "score": 0.92},
        {"text": "let", "start": 6.7, "end": 6.9, "score": 0.92},
        {"text": "go", "start": 7.0, "end": 7.4, "score": 0.92},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 10.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"  Result words: {words}")
    assert [w.lower() for w in words] == ["never", "let", "go", "never", "let", "go"]
    print("  ✓ Passed!")


def test_normal_matching_no_regression():
    print("Testing normal matching (no regression)...")
    user_lyrics = """[00:01.00]Is this the real life
[00:03.50]Is this just fantasy"""
    whisper_words = [
        {"text": "Is", "start": 1.0, "end": 1.2, "score": 0.99},
        {"text": "this", "start": 1.3, "end": 1.5, "score": 0.99},
        {"text": "the", "start": 1.6, "end": 1.8, "score": 0.99},
        {"text": "real", "start": 1.9, "end": 2.2, "score": 0.99},
        {"text": "life", "start": 2.3, "end": 2.8, "score": 0.99},
        {"text": "Is", "start": 3.5, "end": 3.7, "score": 0.99},
        {"text": "this", "start": 3.8, "end": 4.0, "score": 0.99},
        {"text": "just", "start": 4.1, "end": 4.4, "score": 0.99},
        {"text": "fantasy", "start": 4.5, "end": 5.2, "score": 0.99},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 10.0)
    line1_words = [w["word"] for w in segs[0]["words"]]
    line2_words = [w["word"] for w in segs[1]["words"]]
    print(f"  Line 1: {line1_words}")
    print(f"  Line 2: {line2_words}")
    assert line1_words == ["Is", "this", "the", "real", "life"]
    assert line2_words == ["Is", "this", "just", "fantasy"]
    print("  ✓ Passed!")


def test_punctuation_and_contractions():
    print("Testing punctuation and contractions handling...")
    user_lyrics = "[00:10.00]Don't stop believin', I'm holding on"
    whisper_words = [
        {"text": "dont", "start": 10.0, "end": 10.3, "score": 0.95},
        {"text": "stop", "start": 10.4, "end": 10.7, "score": 0.95},
        {"text": "believing", "start": 10.8, "end": 11.3, "score": 0.92},
        {"text": "im", "start": 11.4, "end": 11.6, "score": 0.95},
        {"text": "holding", "start": 11.7, "end": 12.1, "score": 0.95},
        {"text": "on", "start": 12.2, "end": 12.6, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 20.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"  Result words: {words}")
    # User's original casing & punctuation preserved
    assert words == ["Don't", "stop", "believin',", "I'm", "holding", "on"]
    print("  ✓ Passed!")


def test_source_words_priority():
    print("Testing source LRC words authority (source words NEVER replaced by Whisper)...")
    user_lyrics = "[00:14.20]Just the way you are"
    # Whisper transcribed "were" instead of "are"
    whisper_words = [
        {"text": "Just", "start": 14.35, "end": 14.60, "score": 0.95},
        {"text": "the", "start": 14.65, "end": 14.80, "score": 0.95},
        {"text": "way", "start": 14.85, "end": 15.10, "score": 0.95},
        {"text": "you", "start": 15.15, "end": 15.35, "score": 0.95},
        {"text": "were", "start": 15.40, "end": 15.80, "score": 0.85},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 30.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"  Result words: {words}")
    assert words == ["Just", "the", "way", "you", "are"]
    assert words[-1] == "are"  # Authoritative source word preserved
    print("  ✓ Passed!")


def test_preserve_musical_pauses():
    print("Testing preservation of musical pauses (NO cascading word ends)...")
    user_lyrics = "[00:10.00]hello world"
    whisper_words = [
        {"text": "hello", "start": 10.20, "end": 10.45, "score": 0.95},
        {"text": "world", "start": 11.10, "end": 11.35, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 20.0)
    w0 = segs[0]["words"][0]
    w1 = segs[0]["words"][1]
    print(f"  hello: {w0['start']} -> {w0['end']}, world: {w1['start']} -> {w1['end']}")
    # 0.65s gap must be preserved! w0['end'] must NOT be 11.10
    assert abs(w0["end"] - 10.45) < 1e-3
    assert abs(w1["start"] - 11.10) < 1e-3
    gap = w1["start"] - w0["end"]
    assert gap >= 0.60
    print("  ✓ Passed: 0.65s musical pause cleanly preserved!")


def test_alicia_keys_humming_and_anchors():
    print("Testing Alicia Keys humming, mmm, and timestamp stability (Section 28)...")
    user_lyrics = """[ti:If I Ain't Got You]
[ar:Alicia Keys]

[00:00.00]Mmm, mmm, mmm, yeah
[00:08.81]Some lyric here
[00:14.20]Just the way you are
[00:18.50]When you smile"""

    whisper_words = [
        # Humming at start with slight timestamp shifts
        {"text": "Mmm", "start": 0.50, "end": 1.20, "score": 0.88},
        {"text": "mmm", "start": 1.80, "end": 2.40, "score": 0.88},
        {"text": "mmm", "start": 3.10, "end": 3.70, "score": 0.88},
        {"text": "yeah", "start": 4.90, "end": 5.50, "score": 0.92},
        # Line 1: Some lyric here @ 8.81s
        {"text": "Some", "start": 8.85, "end": 9.15, "score": 0.96},
        {"text": "lyric", "start": 9.20, "end": 9.60, "score": 0.96},
        {"text": "here", "start": 9.65, "end": 10.10, "score": 0.96},
        # Line 2: Just the way you are @ 14.20s
        {"text": "Just", "start": 14.25, "end": 14.50, "score": 0.98},
        {"text": "the", "start": 14.55, "end": 14.70, "score": 0.98},
        {"text": "way", "start": 14.75, "end": 15.00, "score": 0.98},
        {"text": "you", "start": 15.05, "end": 15.25, "score": 0.98},
        {"text": "are", "start": 15.30, "end": 15.80, "score": 0.98},
        # Line 3: When you smile @ 18.50s
        {"text": "When", "start": 18.55, "end": 18.80, "score": 0.97},
        {"text": "you", "start": 18.85, "end": 19.05, "score": 0.97},
        {"text": "smile", "start": 19.10, "end": 19.70, "score": 0.97},
    ]

    tags = {}
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 30.0, tags=tags)
    print(f"  Extracted tags: {tags}")
    assert tags.get("title") == "If I Ain't Got You" or tags.get("ti") == "If I Ain't Got You"
    assert len(segs) == 4

    # 1. Verify humming is localized in line 0
    line0_words = [w["word"] for w in segs[0]["words"]]
    print(f"  Line 0: {line0_words}, time: {segs[0]['start']:.2f}s - {segs[0]['end']:.2f}s")
    assert line0_words == ["Mmm,", "mmm,", "mmm,", "yeah"]
    assert segs[0]["end"] <= 6.0

    # 2. Verify Line 1 anchor at 8.81s remains rock-solid
    line1_start = segs[1]["words"][0]["start"]
    print(f"  Line 1: {[w['word'] for w in segs[1]['words']]}, start: {line1_start:.2f}s (anchor 8.81s)")
    assert abs(line1_start - 8.85) < 0.1

    # 3. Verify Line 2 anchor at 14.20s remains rock-solid
    line2_start = segs[2]["words"][0]["start"]
    print(f"  Line 2: {[w['word'] for w in segs[2]['words']]}, start: {line2_start:.2f}s (anchor 14.20s)")
    assert abs(line2_start - 14.25) < 0.1

    # 4. Verify Line 3 anchor at 18.50s remains rock-solid
    line3_start = segs[3]["words"][0]["start"]
    print(f"  Line 3: {[w['word'] for w in segs[3]['words']]}, start: {line3_start:.2f}s (anchor 18.50s)")
    assert abs(line3_start - 18.55) < 0.1

    print("  ✓ Passed: Alicia Keys humming and all timestamps verified stable!")


def test_repeated_lines_disambiguation():
    print("Testing disambiguation of repeated phrases across timestamps...")
    user_lyrics = """[00:10.00]I love you
[00:15.00]I love you
[00:20.00]I love you"""

    whisper_words = [
        # Occurrence 1 @ 10s
        {"text": "I", "start": 10.10, "end": 10.30, "score": 0.95},
        {"text": "love", "start": 10.35, "end": 10.60, "score": 0.95},
        {"text": "you", "start": 10.65, "end": 10.95, "score": 0.95},
        # Occurrence 2 @ 15s
        {"text": "I", "start": 15.10, "end": 15.30, "score": 0.95},
        {"text": "love", "start": 15.35, "end": 15.60, "score": 0.95},
        {"text": "you", "start": 15.65, "end": 15.95, "score": 0.95},
        # Occurrence 3 @ 20s
        {"text": "I", "start": 20.10, "end": 20.30, "score": 0.95},
        {"text": "love", "start": 20.35, "end": 20.60, "score": 0.95},
        {"text": "you", "start": 20.65, "end": 20.95, "score": 0.95},
    ]

    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 30.0)
    assert len(segs) == 3
    assert abs(segs[0]["words"][0]["start"] - 10.10) < 0.05
    assert abs(segs[1]["words"][0]["start"] - 15.10) < 0.05
    assert abs(segs[2]["words"][0]["start"] - 20.10) < 0.05
    print("  ✓ Passed: Repeated phrases properly isolated to their local windows!")


def test_hallucination_rejection():
    print("Testing hallucination rejection in long gaps...")
    user_lyrics = """[00:01.00]Intro phrase
[00:45.00]Chorus begins"""
    whisper_words = [
        {"text": "Intro", "start": 1.0, "end": 1.4, "score": 0.95},
        {"text": "phrase", "start": 1.5, "end": 2.0, "score": 0.95},
        # Hallucinations during 40s instrumental break
        {"text": "Thank", "start": 20.0, "end": 20.3, "score": 0.3},
        {"text": "you", "start": 20.4, "end": 20.6, "score": 0.3},
        {"text": "Subtitles", "start": 30.0, "end": 30.5, "score": 0.3},
        {"text": "by", "start": 30.6, "end": 30.8, "score": 0.3},
        {"text": "Chorus", "start": 45.0, "end": 45.4, "score": 0.95},
        {"text": "begins", "start": 45.5, "end": 46.0, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 60.0)
    # segs contains line 1, [MUSIC] marker, line 2
    words1 = [w["word"] for w in segs[0]["words"]]
    words2 = [w["word"] for w in segs[-1]["words"]]
    print(f"  Seg 1 words: {words1}, Seg Last words: {words2}")
    assert words1 == ["Intro", "phrase"]
    assert words2 == ["Chorus", "begins"]
    print("  ✓ Passed!")


def test_elrc_format_generation():
    print("Testing eLRC format and time formatting...")
    with tempfile.NamedTemporaryFile(suffix=".elrc.lrc", delete=False) as tmp:
        tmp_path = tmp.name

    user_lyrics = "[00:01.20]Ooh I love you yeah"
    whisper_words = [
        {"text": "Ooh", "start": 1.2, "end": 1.6, "score": 0.92},
        {"text": "I", "start": 1.7, "end": 1.9, "score": 0.98},
        {"text": "love", "start": 2.0, "end": 2.3, "score": 0.95},
        {"text": "you", "start": 2.4, "end": 2.8, "score": 0.97},
        {"text": "yeah", "start": 2.9, "end": 3.4, "score": 0.89},
    ]
    tags = {"title": "Test Song", "artist": "Test Artist"}
    output_segments = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 10.0, tags=tags)
    
    content = align.format_elrc(output_segments, tags=tags)
    Path(tmp_path).write_text(content, encoding="utf-8")
    content = Path(tmp_path).read_text(encoding="utf-8")
    print("  Generated eLRC Content:")
    for line in content.strip().splitlines():
        print(f"    {line}")
    
    assert "[by:Yimly Sync]" in content
    assert "[re:Yimly Sync (whisperx)]" in content
    assert "usersync" not in content
    assert "wav2vec2" not in content
    assert "[00:01.20] <00:01.20>Ooh <00:01.70>I <00:02.00>love <00:02.40>you <00:02.90>yeah <00:03.40>" in content
    os.remove(tmp_path)
    print("  ✓ Passed!")


if __name__ == "__main__":
    print("=" * 60)
    print("RUNNING EXTENSIVE ALIGNMENT & RECONCILIATION TEST SUITE")
    print("=" * 60)
    test_missing_sung_vocalizations()
    test_missing_repeated_words()
    test_normal_matching_no_regression()
    test_punctuation_and_contractions()
    test_source_words_priority()
    test_preserve_musical_pauses()
    test_alicia_keys_humming_and_anchors()
    test_repeated_lines_disambiguation()
    test_hallucination_rejection()
    test_elrc_format_generation()
    print("=" * 60)
    print("ALL TESTS PASSED WITH 100% SUCCESS!")
    print("=" * 60)
