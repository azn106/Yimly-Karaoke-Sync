"""
Unit tests for the canonical-first alignment and reconciliation engine in align.py.
"""

import align

def run_tests():
    print("Running alignment & reconciliation test cases...")
    
    # Test 1: Canonical words dictation (Whisper insertions dropped)
    lrc_text = "[00:01.70]I love you"
    whisper_words = [
        {"text": "Ooh", "start": 1.2, "end": 1.6, "score": 0.92},
        {"text": "I", "start": 1.7, "end": 1.9, "score": 0.98},
        {"text": "love", "start": 2.0, "end": 2.3, "score": 0.95},
        {"text": "you", "start": 2.4, "end": 2.8, "score": 0.97},
        {"text": "yeah", "start": 2.9, "end": 3.4, "score": 0.89},
    ]
    segs = align.reconcile_and_align_lyrics(lrc_text, whisper_words, 10.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"Test 1 result words: {words}")
    assert words == ["I", "love", "you"], f"Test 1 failed: {words}"
    assert abs(segs[0]["words"][0]["start"] - 1.7) < 0.1
    print("Test 1 PASSED: Canonical words strictly dictate line tokens!")

    # Test 2: Vocalizations present in canonical lyrics
    lrc_text = "[00:01.20]Ooh, I love you, yeah"
    whisper_words = [
        {"text": "Ooh", "start": 1.2, "end": 1.6, "score": 0.92},
        {"text": "I", "start": 1.7, "end": 1.9, "score": 0.98},
        {"text": "love", "start": 2.0, "end": 2.3, "score": 0.95},
        {"text": "you", "start": 2.4, "end": 2.8, "score": 0.97},
        {"text": "yeah", "start": 2.9, "end": 3.4, "score": 0.89},
    ]
    segs = align.reconcile_and_align_lyrics(lrc_text, whisper_words, 10.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"Test 2 result words: {words}")
    assert words == ["Ooh,", "I", "love", "you,", "yeah"], f"Test 2 failed: {words}"
    print("Test 2 PASSED: Canonical vocalizations properly aligned with audio!")

    # Test 3: Normal match with no extra words
    lrc_text = "[00:10.00]Hello from the other side"
    whisper_words = [
        {"text": "Hello", "start": 10.0, "end": 10.5, "score": 0.99},
        {"text": "from", "start": 10.6, "end": 10.8, "score": 0.99},
        {"text": "the", "start": 10.9, "end": 11.0, "score": 0.99},
        {"text": "other", "start": 11.1, "end": 11.4, "score": 0.99},
        {"text": "side", "start": 11.5, "end": 12.0, "score": 0.99},
    ]
    segs = align.reconcile_and_align_lyrics(lrc_text, whisper_words, 20.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"Test 3 result words: {words}")
    assert words == ["Hello", "from", "the", "other", "side"], f"Test 3 failed: {words}"
    print("Test 3 PASSED: Exact match preserved without regression!")

    # Test 4: Rejection of hallucination during instrumental break
    lrc_text = """[00:05.00]First line here
[00:50.00]Second line later"""
    whisper_words = [
        {"text": "First", "start": 5.0, "end": 5.4, "score": 0.95},
        {"text": "line", "start": 5.5, "end": 5.8, "score": 0.95},
        {"text": "here", "start": 5.9, "end": 6.3, "score": 0.95},
        # Hallucination at t=25 (19s after line 1 and 25s before line 2)
        {"text": "Thank", "start": 25.0, "end": 25.3, "score": 0.4},
        {"text": "you", "start": 25.4, "end": 25.7, "score": 0.4},
        {"text": "for", "start": 25.8, "end": 26.0, "score": 0.4},
        {"text": "watching", "start": 26.1, "end": 26.5, "score": 0.4},
        {"text": "Second", "start": 50.0, "end": 50.4, "score": 0.95},
        {"text": "line", "start": 50.5, "end": 50.8, "score": 0.95},
        {"text": "later", "start": 50.9, "end": 51.5, "score": 0.95},
    ]
    segs = align.reconcile_and_align_lyrics(lrc_text, whisper_words, 60.0)
    seg1_words = [w["word"] for w in segs[0]["words"]]
    seg2_words = [w["word"] for w in segs[-1]["words"]]
    print(f"Test 4 seg 1 words: {seg1_words}, seg 2 words: {seg2_words}")
    assert seg1_words == ["First", "line", "here"], f"Test 4 failed seg 1: {seg1_words}"
    assert seg2_words == ["Second", "line", "later"], f"Test 4 failed seg 2: {seg2_words}"
    print("Test 4 PASSED: Hallucination in long break successfully rejected!")

    # Test 5: Punctuation, apostrophes, and contractions
    lrc_text = "[00:03.00]Don't you know, I'm gonna stay"
    whisper_words = [
        {"text": "dont", "start": 3.0, "end": 3.4, "score": 0.95},
        {"text": "you", "start": 3.5, "end": 3.7, "score": 0.95},
        {"text": "know", "start": 3.8, "end": 4.1, "score": 0.95},
        {"text": "im", "start": 4.2, "end": 4.5, "score": 0.95},
        {"text": "going", "start": 4.6, "end": 4.9, "score": 0.92},
        {"text": "stay", "start": 5.0, "end": 5.5, "score": 0.97},
    ]
    segs = align.reconcile_and_align_lyrics(lrc_text, whisper_words, 10.0)
    words = [w["word"] for w in segs[0]["words"]]
    print(f"Test 5 result words: {words}")
    assert words == ["Don't", "you", "know,", "I'm", "gonna", "stay"], f"Test 5 failed: {words}"
    print("Test 5 PASSED: Punctuation & contraction matching works seamlessly!")

    print("\nALL RECONCILIATION TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    run_tests()
