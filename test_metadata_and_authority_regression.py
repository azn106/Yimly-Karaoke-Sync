"""
Regression test suite specifically verifying:
1. 'usersync' metadata is replaced in all outputs.
2. 'wav2vec2' metadata is replaced in all outputs.
3. Final output contains exactly:
   [by:Yimly Sync]
   [re:Yimly Sync (whisperx)]
   and cannot be overwritten by incoming source/existing LRC tags.
4. Canonical lyrics remain strictly authoritative (words, order, casing, punctuation).
5. WhisperX only supplies timing, not lyric content (hallucinations/ad-libs discarded).
6. Repeated/overlapping Whisper detections do not create duplicate lyric lines.
"""

import os
import sys
import align


def test_1_2_3_metadata_yimly_sync_enforcement():
    print("Test 1-3: Metadata requirement - Yimly Sync hardcoded, usersync & wav2vec2 replaced...")
    
    # Case A: Input LRC contains existing usersync & wav2vec2 tags + custom tags
    user_lyrics = """[ti:Old Song Title]
[ar:Old Artist]
[al:Old Album]
[by:usersync]
[re:usersync (whisperx wav2vec2)]
[00:01.00]First line of lyrics
[00:05.00]Second line of lyrics"""

    whisper_words = [
        {"text": "First", "start": 1.0, "end": 1.3, "score": 0.95},
        {"text": "line", "start": 1.4, "end": 1.7, "score": 0.95},
        {"text": "of", "start": 1.8, "end": 1.9, "score": 0.95},
        {"text": "lyrics", "start": 2.0, "end": 2.5, "score": 0.95},
        {"text": "Second", "start": 5.0, "end": 5.3, "score": 0.95},
        {"text": "line", "start": 5.4, "end": 5.7, "score": 0.95},
        {"text": "of", "start": 5.8, "end": 5.9, "score": 0.95},
        {"text": "lyrics", "start": 6.0, "end": 6.6, "score": 0.95},
    ]

    tags = {}
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 10.0, tags=tags)
    
    # Generate final LRC output via format_elrc
    lrc_output = align.format_elrc(segs, tags=tags)
    print("  Generated LRC Header & Content:")
    for line in lrc_output.strip().splitlines()[:8]:
        print(f"    {line}")

    # Check 1: usersync is completely absent
    assert "usersync" not in lrc_output, "Assertion Failed: 'usersync' must not appear in output!"
    
    # Check 2: wav2vec2 is completely absent
    assert "wav2vec2" not in lrc_output, "Assertion Failed: 'wav2vec2' must not appear in output!"
    
    # Check 3: Output contains EXACTLY [by:Yimly Sync] and [re:Yimly Sync (whisperx)]
    assert "[by:Yimly Sync]" in lrc_output, "Assertion Failed: '[by:Yimly Sync]' missing from output!"
    assert "[re:Yimly Sync (whisperx)]" in lrc_output, "Assertion Failed: '[re:Yimly Sync (whisperx)]' missing from output!"
    
    # Check that incoming tags object with malicious / old 'by' and 're' cannot overwrite
    malicious_tags = {
        "title": "My Song",
        "artist": "My Artist",
        "by": "malicious_override",
        "re": "old_tool_override"
    }
    lrc_output2 = align.format_elrc(segs, tags=malicious_tags)
    assert "[by:Yimly Sync]" in lrc_output2
    assert "[re:Yimly Sync (whisperx)]" in lrc_output2
    assert "malicious_override" not in lrc_output2
    assert "old_tool_override" not in lrc_output2

    print("  ✓ Passed: All metadata enforcement checks passed!")


def test_4_canonical_lyrics_remain_authoritative():
    print("Test 4: Canonical lyrics authority - casing, punctuation, line breaks preserved...")
    user_lyrics = """[00:10.00]Don't stop believin', hold on!
[00:15.00]Streetlights, people, oh-whoa..."""

    # Whisper output with lowercase, missing punctuation, different formatting
    whisper_words = [
        {"text": "dont", "start": 10.0, "end": 10.3, "score": 0.95},
        {"text": "stop", "start": 10.4, "end": 10.7, "score": 0.95},
        {"text": "believing", "start": 10.8, "end": 11.3, "score": 0.95},
        {"text": "hold", "start": 11.4, "end": 11.6, "score": 0.95},
        {"text": "on", "start": 11.7, "end": 12.0, "score": 0.95},
        {"text": "street", "start": 15.0, "end": 15.2, "score": 0.95},
        {"text": "lights", "start": 15.25, "end": 15.5, "score": 0.95},
        {"text": "people", "start": 15.6, "end": 16.0, "score": 0.95},
        {"text": "oh", "start": 16.1, "end": 16.4, "score": 0.95},
        {"text": "whoa", "start": 16.5, "end": 17.0, "score": 0.95},
    ]

    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 30.0)
    assert len(segs) == 2

    words_line1 = [w["word"] for w in segs[0]["words"]]
    words_line2 = [w["word"] for w in segs[1]["words"]]

    print(f"  Line 1 words: {words_line1}")
    print(f"  Line 2 words: {words_line2}")

    # Exact canonical words, casing and punctuation must be preserved
    assert words_line1 == ["Don't", "stop", "believin',", "hold", "on!"]
    assert words_line2 == ["Streetlights,", "people,", "oh-whoa..."]
    print("  ✓ Passed: Canonical text, casing, and punctuation strictly preserved!")


def test_5_whisper_supplies_timing_not_content():
    print("Test 5: Whisper supplies timing only - unprompted ad-libs & hallucinations dropped...")
    user_lyrics = "[00:20.00]I want you to stay"

    # Whisper transcribed extra vocal ad-libs and chatter around and inside the phrase
    whisper_words = [
        {"text": "yeah", "start": 19.0, "end": 19.4, "score": 0.85},   # leading ad-lib not in lyrics
        {"text": "I", "start": 20.0, "end": 20.2, "score": 0.98},
        {"text": "really", "start": 20.25, "end": 20.45, "score": 0.80}, # hallucinated insertion
        {"text": "want", "start": 20.5, "end": 20.8, "score": 0.98},
        {"text": "you", "start": 20.9, "end": 21.1, "score": 0.98},
        {"text": "baby", "start": 21.15, "end": 21.4, "score": 0.85},  # mid ad-lib not in lyrics
        {"text": "to", "start": 21.45, "end": 21.6, "score": 0.98},
        {"text": "stay", "start": 21.65, "end": 22.2, "score": 0.98},
        {"text": "whoa", "start": 22.3, "end": 22.8, "score": 0.85},   # trailing ad-lib not in lyrics
    ]

    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 30.0)
    assert len(segs) == 1
    words = [w["word"] for w in segs[0]["words"]]
    print(f"  Result words: {words}")
    assert words == ["I", "want", "you", "to", "stay"]
    assert abs(segs[0]["words"][0]["start"] - 20.0) < 0.1
    assert abs(segs[0]["words"][-1]["end"] - 22.2) < 0.1
    print("  ✓ Passed: Extra words/ad-libs discarded, audio timing retained!")


def test_6_repeated_overlapping_whisper_detections_no_duplicate_lines():
    print("Test 6: Repeated/overlapping Whisper detections do not create duplicate lines...")
    user_lyrics = """[00:05.00]Hold on to what we have
[00:10.00]Never let it go"""

    # Whisper produced overlapping duplicated transcription windows for the same audio
    whisper_words = [
        # Window A (chunk 1)
        {"text": "Hold", "start": 5.0, "end": 5.3, "score": 0.95},
        {"text": "on", "start": 5.35, "end": 5.55, "score": 0.95},
        {"text": "to", "start": 5.6, "end": 5.75, "score": 0.95},
        {"text": "what", "start": 5.8, "end": 6.0, "score": 0.95},
        {"text": "we", "start": 6.05, "end": 6.2, "score": 0.95},
        {"text": "have", "start": 6.25, "end": 6.8, "score": 0.95},
        # Window B (overlapping duplicate chunk from sliding window whisper inference)
        {"text": "Hold", "start": 5.05, "end": 5.32, "score": 0.92},
        {"text": "on", "start": 5.36, "end": 5.56, "score": 0.92},
        {"text": "to", "start": 5.61, "end": 5.76, "score": 0.92},
        {"text": "what", "start": 5.81, "end": 6.02, "score": 0.92},
        {"text": "we", "start": 6.06, "end": 6.22, "score": 0.92},
        {"text": "have", "start": 6.26, "end": 6.82, "score": 0.92},
        # Line 2
        {"text": "Never", "start": 10.0, "end": 10.3, "score": 0.95},
        {"text": "let", "start": 10.35, "end": 10.6, "score": 0.95},
        {"text": "it", "start": 10.65, "end": 10.8, "score": 0.95},
        {"text": "go", "start": 10.85, "end": 11.5, "score": 0.95},
        # Duplicate of line 2
        {"text": "Never", "start": 10.05, "end": 10.35, "score": 0.90},
        {"text": "let", "start": 10.4, "end": 10.65, "score": 0.90},
        {"text": "it", "start": 10.7, "end": 10.85, "score": 0.90},
        {"text": "go", "start": 10.9, "end": 11.55, "score": 0.90},
    ]

    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 20.0)
    # Output must have EXACTLY 2 lines corresponding to canonical lines, NO extra duplicated lines
    assert len(segs) == 2, f"Expected 2 lines, got {len(segs)}"
    assert [w["word"] for w in segs[0]["words"]] == ["Hold", "on", "to", "what", "we", "have"]
    assert [w["word"] for w in segs[1]["words"]] == ["Never", "let", "it", "go"]
    print("  ✓ Passed: Overlapping whisper detections cleanly reconciled into single canonical lines!")


if __name__ == "__main__":
    print("=" * 70)
    print("RUNNING METADATA & CANONICAL AUTHORITY REGRESSION TEST SUITE")
    print("=" * 70)
    test_1_2_3_metadata_yimly_sync_enforcement()
    test_4_canonical_lyrics_remain_authoritative()
    test_5_whisper_supplies_timing_not_content()
    test_6_repeated_overlapping_whisper_detections_no_duplicate_lines()
    print("=" * 70)
    print("ALL METADATA & CANONICAL AUTHORITY REGRESSION CHECKS PASSED 100%!")
    print("=" * 70)
