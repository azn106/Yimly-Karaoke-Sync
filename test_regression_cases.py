"""
Test suite covering all user regression cases and alignment requirements.
"""

import sys
import align

def test_problem_1_3_4_line_overlapping():
    print("Test 1: Problem 1, 3, 4 - Non-overlapping sequential lines")
    user_lyrics = """[00:08.81] Some people live for the fortune
[00:10.50] Some people live just for the fame"""
    whisper_words = [
        {"text": "Some", "start": 8.81, "end": 9.15, "score": 0.99},
        {"text": "people", "start": 9.20, "end": 9.55, "score": 0.99},
        {"text": "live", "start": 9.60, "end": 9.85, "score": 0.99},
        {"text": "for", "start": 9.90, "end": 10.05, "score": 0.99},
        {"text": "the", "start": 10.10, "end": 10.25, "score": 0.99},
        {"text": "fortune", "start": 10.30, "end": 10.50, "score": 0.99},
        {"text": "Some", "start": 10.55, "end": 10.85, "score": 0.99},
        {"text": "people", "start": 10.90, "end": 11.20, "score": 0.99},
        {"text": "live", "start": 11.25, "end": 11.50, "score": 0.99},
        {"text": "just", "start": 11.55, "end": 11.75, "score": 0.99},
        {"text": "for", "start": 11.80, "end": 11.95, "score": 0.99},
        {"text": "the", "start": 12.00, "end": 12.15, "score": 0.99},
        {"text": "fame", "start": 12.20, "end": 12.75, "score": 0.99},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 30.0)
    assert len(segs) == 2, f"Expected 2 lines, got {len(segs)}"
    assert segs[0]["end"] <= segs[1]["start"], f"Line 1 ({segs[0]['end']}) must not overlap Line 2 ({segs[1]['start']})"
    assert [w["word"] for w in segs[0]["words"]] == ["Some", "people", "live", "for", "the", "fortune"]
    assert [w["word"] for w in segs[1]["words"]] == ["Some", "people", "live", "just", "for", "the", "fame"]
    print("  ✓ Passed!")

def test_problem_2_canonical_order_preservation():
    print("Test 2: Problem 2 - Canonical line order invariant")
    user_lyrics = """[00:48.91] Some people want it all
[00:49.18] So full of the superficial"""
    # Even if Whisper transcribed out of order or close together
    whisper_words = [
        {"text": "So", "start": 49.18, "end": 49.35, "score": 0.95},
        {"text": "full", "start": 49.40, "end": 49.65, "score": 0.95},
        {"text": "of", "start": 49.70, "end": 49.80, "score": 0.95},
        {"text": "the", "start": 49.85, "end": 49.95, "score": 0.95},
        {"text": "superficial", "start": 50.00, "end": 50.80, "score": 0.95},
        {"text": "Some", "start": 48.91, "end": 49.15, "score": 0.95},
        {"text": "people", "start": 49.18, "end": 49.35, "score": 0.95},
        {"text": "want", "start": 49.40, "end": 49.55, "score": 0.95},
        {"text": "it", "start": 49.60, "end": 49.70, "score": 0.95},
        {"text": "all", "start": 49.75, "end": 50.10, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 60.0)
    assert len(segs) == 2
    assert [w["word"] for w in segs[0]["words"]] == ["Some", "people", "want", "it", "all"]
    assert [w["word"] for w in segs[1]["words"]] == ["So", "full", "of", "the", "superficial"]
    print("  ✓ Passed!")

def test_problem_5_whisper_hallucination_dropped():
    print("Test 5: Problem 5 - Erroneous Whisper insertions dropped")
    user_lyrics = "[02:15.62] But I don't want nothing at all"
    whisper_words = [
        {"text": "But", "start": 135.62, "end": 135.80, "score": 0.95},
        {"text": "I", "start": 135.85, "end": 136.00, "score": 0.95},
        {"text": "no", "start": 136.05, "end": 136.20, "score": 0.90},  # Hallucinated insertion
        {"text": "don't", "start": 136.25, "end": 136.50, "score": 0.95},
        {"text": "want", "start": 136.55, "end": 136.80, "score": 0.95},
        {"text": "nothing", "start": 136.85, "end": 137.20, "score": 0.95},
        {"text": "at", "start": 137.25, "end": 137.40, "score": 0.95},
        {"text": "all", "start": 137.45, "end": 138.00, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 180.0)
    assert len(segs) == 1
    words = [w["word"] for w in segs[0]["words"]]
    assert words == ["But", "I", "don't", "want", "nothing", "at", "all"], f"Got words: {words}"
    print("  ✓ Passed!")

def test_problem_6_suspicious_timestamp_jump():
    print("Test 6: Problem 6 - Outlier timestamp jump smoothed")
    user_lyrics = "[02:23.38] Some people want diamond rings"
    whisper_words = [
        {"text": "Some", "start": 143.38, "end": 143.70, "score": 0.98},
        {"text": "people", "start": 147.79, "end": 148.00, "score": 0.60}, # Outlier jump from bad match
        {"text": "want", "start": 144.10, "end": 144.40, "score": 0.95},
        {"text": "diamond", "start": 144.45, "end": 144.85, "score": 0.95},
        {"text": "rings", "start": 144.90, "end": 145.50, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 180.0)
    assert len(segs) == 1
    words = segs[0]["words"]
    # Check monotonicity
    for i in range(len(words) - 1):
        assert words[i]["start"] <= words[i+1]["start"]
        assert words[i]["end"] <= words[i+1]["start"] + 0.001
    print("  ✓ Passed!")

def test_problem_7_unrequested_adlib_dropped():
    print("Test 7: Problem 7 - Unrequested ad-lib not inserted into canonical lyrics")
    user_lyrics = "[02:30.00] Some just want everything"
    whisper_words = [
        {"text": "Some", "start": 150.00, "end": 150.30, "score": 0.95},
        {"text": "just", "start": 150.35, "end": 150.60, "score": 0.95},
        {"text": "want", "start": 150.65, "end": 150.90, "score": 0.95},
        {"text": "baby", "start": 150.95, "end": 151.20, "score": 0.90},  # Inserted ad-lib
        {"text": "everything", "start": 151.25, "end": 152.00, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 180.0)
    assert len(segs) == 1
    words = [w["word"] for w in segs[0]["words"]]
    assert words == ["Some", "just", "want", "everything"], f"Got {words}"
    print("  ✓ Passed!")

def test_problem_9_overlapping_competing_whisper_segments():
    print("Test 9: Problem 9 - Overlapping competing Whisper segments reconciled")
    user_lyrics = "[03:15.00] If I ain't got you with me, baby"
    whisper_words = [
        # Segment 1
        {"text": "If", "start": 195.00, "end": 195.20, "score": 0.95},
        {"text": "I", "start": 195.25, "end": 195.40, "score": 0.95},
        {"text": "ain't", "start": 195.45, "end": 195.70, "score": 0.95},
        {"text": "got", "start": 195.75, "end": 196.00, "score": 0.95},
        {"text": "you", "start": 196.05, "end": 196.50, "score": 0.95},
        # Competing Segment 2
        {"text": "If", "start": 195.10, "end": 195.30, "score": 0.95},
        {"text": "I", "start": 195.35, "end": 195.50, "score": 0.95},
        {"text": "ain't", "start": 195.55, "end": 195.80, "score": 0.95},
        {"text": "got", "start": 195.85, "end": 196.10, "score": 0.95},
        {"text": "you", "start": 196.15, "end": 196.60, "score": 0.95},
        {"text": "with", "start": 196.65, "end": 196.85, "score": 0.95},
        {"text": "me", "start": 196.90, "end": 197.10, "score": 0.95},
        {"text": "baby", "start": 197.15, "end": 197.80, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(user_lyrics, whisper_words, 240.0)
    assert len(segs) == 1
    words = [w["word"] for w in segs[0]["words"]]
    assert words == ["If", "I", "ain't", "got", "you", "with", "me,", "baby"], f"Got {words}"
    print("  ✓ Passed!")

def test_full_song_regression():
    print("Test 10: Full song lyrics alignment simulation (Alicia Keys - If I Ain't Got You)")
    lyrics = """[ti:If I Ain't Got You]
[ar:Alicia Keys]
[al:The Diary of Alicia Keys]
[00:08.81] Some people live for the fortune
[00:10.50] Some people live just for the fame
[00:48.91] Some people want it all
[00:49.18] So full of the superficial
[01:13.64] Some just want everything
[01:14.64] But everything means nothing
[01:55.42] And what good would it be?
[01:56.63] With no one to share
[02:15.62] But I don't want nothing at all
[02:23.38] Some people want diamond rings
[02:30.00] Some just want everything
[03:02.98] Some just want everything
[03:06.91] But everything means nothing
[03:15.00] If I ain't got you with me, baby"""

    whisper_words = [
        # 00:08
        {"text": "Some", "start": 8.81, "end": 9.15, "score": 0.99},
        {"text": "people", "start": 9.20, "end": 9.55, "score": 0.99},
        {"text": "live", "start": 9.60, "end": 9.85, "score": 0.99},
        {"text": "for", "start": 9.90, "end": 10.05, "score": 0.99},
        {"text": "the", "start": 10.10, "end": 10.25, "score": 0.99},
        {"text": "fortune", "start": 10.30, "end": 10.50, "score": 0.99},
        # 00:10
        {"text": "Some", "start": 10.55, "end": 10.85, "score": 0.99},
        {"text": "people", "start": 10.90, "end": 11.20, "score": 0.99},
        {"text": "live", "start": 11.25, "end": 11.50, "score": 0.99},
        {"text": "just", "start": 11.55, "end": 11.75, "score": 0.99},
        {"text": "for", "start": 11.80, "end": 11.95, "score": 0.99},
        {"text": "the", "start": 12.00, "end": 12.15, "score": 0.99},
        {"text": "fame", "start": 12.20, "end": 12.75, "score": 0.99},
        # 00:48
        {"text": "Some", "start": 48.91, "end": 49.15, "score": 0.95},
        {"text": "people", "start": 49.18, "end": 49.35, "score": 0.95},
        {"text": "want", "start": 49.40, "end": 49.55, "score": 0.95},
        {"text": "it", "start": 49.60, "end": 49.70, "score": 0.95},
        {"text": "all", "start": 49.75, "end": 50.10, "score": 0.95},
        # 00:50
        {"text": "So", "start": 50.50, "end": 50.70, "score": 0.95},
        {"text": "full", "start": 50.75, "end": 51.00, "score": 0.95},
        {"text": "of", "start": 51.05, "end": 51.15, "score": 0.95},
        {"text": "the", "start": 51.20, "end": 51.30, "score": 0.95},
        {"text": "superficial", "start": 51.35, "end": 52.10, "score": 0.95},
        # 01:13
        {"text": "Some", "start": 73.64, "end": 73.90, "score": 0.95},
        {"text": "just", "start": 73.95, "end": 74.20, "score": 0.95},
        {"text": "want", "start": 74.25, "end": 74.50, "score": 0.95},
        {"text": "everything", "start": 74.55, "end": 75.20, "score": 0.95},
        # 01:15
        {"text": "But", "start": 75.50, "end": 75.70, "score": 0.95},
        {"text": "everything", "start": 75.75, "end": 76.30, "score": 0.95},
        {"text": "means", "start": 76.35, "end": 76.60, "score": 0.95},
        {"text": "nothing", "start": 76.65, "end": 77.20, "score": 0.95},
        # 01:55
        {"text": "And", "start": 115.42, "end": 115.60, "score": 0.95},
        {"text": "what", "start": 115.65, "end": 115.85, "score": 0.95},
        {"text": "good", "start": 115.90, "end": 116.15, "score": 0.95},
        {"text": "would", "start": 116.20, "end": 116.40, "score": 0.95},
        {"text": "it", "start": 116.45, "end": 116.55, "score": 0.95},
        {"text": "be", "start": 116.60, "end": 117.00, "score": 0.95},
        # 01:56
        {"text": "With", "start": 117.20, "end": 117.40, "score": 0.95},
        {"text": "no", "start": 117.45, "end": 117.65, "score": 0.95},
        {"text": "one", "start": 117.70, "end": 117.90, "score": 0.95},
        {"text": "to", "start": 117.95, "end": 118.05, "score": 0.95},
        {"text": "share", "start": 118.10, "end": 118.60, "score": 0.95},
        # 02:15 with hallucination "no"
        {"text": "But", "start": 135.62, "end": 135.80, "score": 0.95},
        {"text": "I", "start": 135.85, "end": 136.00, "score": 0.95},
        {"text": "no", "start": 136.05, "end": 136.20, "score": 0.90},
        {"text": "dont", "start": 136.25, "end": 136.50, "score": 0.95},
        {"text": "want", "start": 136.55, "end": 136.80, "score": 0.95},
        {"text": "nothing", "start": 136.85, "end": 137.20, "score": 0.95},
        {"text": "at", "start": 137.25, "end": 137.40, "score": 0.95},
        {"text": "all", "start": 137.45, "end": 138.00, "score": 0.95},
        # 02:23
        {"text": "Some", "start": 143.38, "end": 143.70, "score": 0.98},
        {"text": "people", "start": 143.75, "end": 144.10, "score": 0.95},
        {"text": "want", "start": 144.15, "end": 144.40, "score": 0.95},
        {"text": "diamond", "start": 144.45, "end": 144.85, "score": 0.95},
        {"text": "rings", "start": 144.90, "end": 145.50, "score": 0.95},
        # 02:30 with ad-lib "baby"
        {"text": "Some", "start": 150.00, "end": 150.30, "score": 0.95},
        {"text": "just", "start": 150.35, "end": 150.60, "score": 0.95},
        {"text": "want", "start": 150.65, "end": 150.90, "score": 0.95},
        {"text": "baby", "start": 150.95, "end": 151.20, "score": 0.90},
        {"text": "everything", "start": 151.25, "end": 152.00, "score": 0.95},
        # 03:02
        {"text": "Some", "start": 182.98, "end": 183.25, "score": 0.95},
        {"text": "just", "start": 183.30, "end": 183.55, "score": 0.95},
        {"text": "want", "start": 183.60, "end": 183.85, "score": 0.95},
        {"text": "everything", "start": 183.90, "end": 184.60, "score": 0.95},
        # 03:06
        {"text": "But", "start": 186.91, "end": 187.10, "score": 0.95},
        {"text": "everything", "start": 187.15, "end": 187.70, "score": 0.95},
        {"text": "means", "start": 187.75, "end": 188.00, "score": 0.95},
        {"text": "nothing", "start": 188.05, "end": 188.70, "score": 0.95},
        # 03:15
        {"text": "If", "start": 195.00, "end": 195.20, "score": 0.95},
        {"text": "I", "start": 195.25, "end": 195.40, "score": 0.95},
        {"text": "aint", "start": 195.45, "end": 195.70, "score": 0.95},
        {"text": "got", "start": 195.75, "end": 196.00, "score": 0.95},
        {"text": "you", "start": 196.05, "end": 196.40, "score": 0.95},
        {"text": "with", "start": 196.45, "end": 196.65, "score": 0.95},
        {"text": "me", "start": 196.70, "end": 196.90, "score": 0.95},
        {"text": "baby", "start": 196.95, "end": 197.60, "score": 0.95},
    ]

    tags = {}
    segs = align.reconcile_and_align_lyrics(lyrics, whisper_words, 240.0, tags=tags)
    
    # Filter out [MUSIC] markers for checking canonical lyric lines
    lyric_segs = [s for s in segs if s.get("text") != "[MUSIC]"]
    assert len(lyric_segs) == 14, f"Expected 14 canonical lines, got {len(lyric_segs)}"

    # Verify chronological ordering and non-overlapping lines
    for i in range(len(lyric_segs) - 1):
        l1 = lyric_segs[i]
        l2 = lyric_segs[i + 1]
        assert l1["start"] <= l2["start"], f"Line {i} start {l1['start']} must be <= Line {i+1} start {l2['start']}"
        assert l1["end"] <= l2["start"] + 0.001, f"Line {i} end {l1['end']} must not overlap Line {i+1} start {l2['start']}"
        
        # Word monotonicity
        for w_idx in range(len(l1["words"]) - 1):
            assert l1["words"][w_idx]["start"] <= l1["words"][w_idx + 1]["start"]
            assert l1["words"][w_idx]["end"] <= l1["words"][w_idx + 1]["start"] + 0.001

    print("  ✓ Passed all full song regression checks!")

if __name__ == "__main__":
    test_problem_1_3_4_line_overlapping()
    test_problem_2_canonical_order_preservation()
    test_problem_5_whisper_hallucination_dropped()
    test_problem_6_suspicious_timestamp_jump()
    test_problem_7_unrequested_adlib_dropped()
    test_problem_9_overlapping_competing_whisper_segments()
    test_full_song_regression()
    print("\nALL REGRESSION TESTS PASSED SUCCESSFULLY!")
