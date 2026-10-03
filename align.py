#!/usr/bin/env python3
"""
Yimly Sync / usersync Alignment Engine v2

Canonical-first lyric reconciliation with WhisperX timing evidence.

Architecture
------------
PHASE 0  Optional Demucs vocal isolation
PHASE 1  faster-whisper streaming transcription
PHASE 2  WhisperX wav2vec2/CTC forced alignment
PHASE 3  Canonical-first v2 reconciliation
PHASE 4  Enhanced word-level LRC export

CORE PRINCIPLE
--------------
Canonical lyrics are authoritative.

The audio transcription is NOT allowed to:
    - add words
    - remove canonical words
    - reorder canonical words
    - replace canonical wording
    - replace canonical punctuation/casing
    - invent lyric lines

WhisperX is used ONLY as timing evidence.

V2 improvements
---------------
- line-aware monotonic alignment
- repeated-word protection
- local anchor windows
- lexical confidence scoring
- contraction expansion matching
- pronunciation/stem matching
- vocalization matching
- one-to-many / many-to-one lexical compatibility
- temporal continuity scoring
- anchor confidence
- outlier rejection
- adaptive interpolation
- pause preservation
- instrumental gap detection
- strict timestamp sanitisation
- no None timestamps at output
- canonical text preservation
- streaming diagnostics
"""

import argparse
import bisect
import json
import math
import os
import re
import sys
import time
import traceback
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ============================================================================
# MODEL CACHE
# ============================================================================

_APP_ROOT = Path(__file__).resolve().parent
_MODELS_DIR = str(_APP_ROOT / "models")

os.environ.setdefault("TORCH_HOME", _MODELS_DIR)
os.environ.setdefault("HF_HOME", _MODELS_DIR)
os.environ.setdefault("XDG_CACHE_HOME", _MODELS_DIR)
os.environ.setdefault("TRANSFORMERS_CACHE", _MODELS_DIR)


# ============================================================================
# LOGGING
# ============================================================================

def log(level: str, msg: str):
    sys.stderr.write(f"[{level}] {msg}\n")
    sys.stderr.flush()


def progress(pct: int, msg: str = ""):
    pct = max(0, min(100, int(pct)))
    sys.stderr.write(f"[PROG] {pct} {msg}\n")
    sys.stderr.flush()


def seg_event(t0: float, t1: float, text: str):
    text = str(text).replace("\n", " ").strip()
    if len(text) > 100:
        text = text[:97] + "..."
    sys.stderr.write(f"[SEG] {t0:.2f} {t1:.2f} {text}\n")
    sys.stderr.flush()


def word_event(t: float, canonical: str, whisper: str):
    sys.stderr.write(
        f"[WORD] {float(t):.3f} {canonical} <-> {whisper}\n"
    )
    sys.stderr.flush()


# ============================================================================
# CONSTANTS
# ============================================================================

MIN_WORD_DURATION_SEC = 0.035
MIN_PAUSE_GAP_SEC = 0.012

MAX_SUSTAINED_WORD_SEC = 10.0

MUSIC_GAP_SEC = 8.0

DEFAULT_FALLBACK_WORD_DUR = 0.32

MAX_INTRA_LINE_JUMP_SEC = 2.5

MAX_ANCHOR_DRIFT_HARD_SEC = 18.0

# Stronger temporal continuity in v2.
TEMPORAL_CONTINUITY_WEIGHT = 0.22

# Penalty for skipping canonical words.
CANONICAL_SKIP_PENALTY = -1.55

# Whisper insertions are cheap to ignore.
WHISPER_SKIP_PENALTY = -0.03

# Minimum lexical confidence required for a usable anchor.
MIN_ANCHOR_SCORE = 1.05

# Repeated/common words should not create weak long-distance anchors.
COMMON_WORDS = {
    "a", "an", "the", "i", "me", "my", "you", "your",
    "we", "us", "our", "he", "she", "it", "they",
    "to", "of", "and", "or", "in", "on", "for",
    "is", "am", "are", "was", "were", "be",
    "yeah", "yea", "oh", "ooh", "ah", "mmm",
    "baby", "love", "know", "got", "get",
}


# ============================================================================
# LEXICAL MAPS
# ============================================================================

CONTRACTION_MAP = {
    "aint": {"aint", "is", "am", "are", "have", "has", "not"},
    "dont": {"dont", "do", "not"},
    "im": {"im", "i", "am"},
    "gonna": {"gonna", "going", "goin", "to"},
    "wanna": {"wanna", "want", "to"},
    "gotta": {"gotta", "got", "to"},
    "kinda": {"kinda", "kind", "of"},
    "sorta": {"sorta", "sort", "of"},
    "lemme": {"lemme", "let", "me"},
    "gimme": {"gimme", "give", "me"},
    "cause": {"cause", "because"},
    "cmon": {"cmon", "come", "on"},
    "youre": {"youre", "you", "are"},
    "didnt": {"didnt", "did", "not"},
    "cant": {"cant", "can", "not", "cannot"},
    "wont": {"wont", "will", "not"},
    "isnt": {"isnt", "is", "not"},
    "arent": {"arent", "are", "not"},
    "havent": {"havent", "have", "not"},
    "hasnt": {"hasnt", "has", "not"},
    "hadnt": {"hadnt", "had", "not"},
    "wouldnt": {"wouldnt", "would", "not"},
    "couldnt": {"couldnt", "could", "not"},
    "shouldnt": {"shouldnt", "should", "not"},
    "theyre": {"theyre", "they", "are"},
    "were": {"were", "we", "are"},
    "its": {"its", "it", "is"},
    "thats": {"thats", "that", "is"},
    "whats": {"whats", "what", "is"},
    "lets": {"lets", "let", "us"},
}

VOCALIZATION_EQUIV = {
    "mmm": {"mm", "mmm", "mmmm", "hmm", "hm", "hmmm", "mhm", "hum"},
    "ooh": {"ooh", "oooh", "ooooh", "oo", "oh", "ooh-ooh"},
    "oh": {"oh", "ohh", "ohhh", "ohoh", "oh-oh"},
    "ah": {"ah", "ahh", "ahhh", "aah", "aaah", "ha"},
    "yeah": {"yeah", "yea", "yah", "yep", "yay", "ya", "yup"},
    "woah": {"woah", "whoa", "whoaa", "wow"},
    "whoo": {"woo", "wooo", "whoo", "whooo"},
}

HALLUCINATION_BLACKLIST = {
    "subtitles",
    "subtitle",
    "transcription",
    "transcript",
    "amara.org",
    "opensubtitles",
    "translated",
    "translated by",
    "thank you for watching",
    "thanks for watching",
    "subscribe",
    "please subscribe",
    "like and subscribe",
    "copyright",
    "all rights reserved",
    "closed captions",
    "watching!",
    "for watching",
    "subtitles by",
}


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class CanonicalLine:
    text: str
    time: Optional[float]
    source_index: int
    estimated: bool = False
    raw_line: str = ""

    @property
    def words(self) -> List[str]:
        return [w for w in self.text.split() if w.strip()]


@dataclass
class CanonicalWord:
    original_text: str
    line_idx: int
    word_idx_in_line: int
    global_idx: int
    line_anchor: Optional[float]
    is_estimated: bool


# ============================================================================
# BASIC TEXT FUNCTIONS
# ============================================================================

def clean_word(value) -> str:
    if value is None:
        return ""

    s = unicodedata.normalize("NFKD", str(value))

    s = (
        s.replace("’", "'")
         .replace("‘", "'")
         .replace("`", "'")
         .replace("“", '"')
         .replace("”", '"')
    )

    return s.strip()


def normalize_for_match(value: str) -> str:
    s = clean_word(value).lower()

    # Normalize apostrophe variants.
    s = s.replace("'", "")

    # Remove punctuation while retaining Unicode word characters.
    s = re.sub(r"[^\w]", "", s)

    return s


def is_hallucination_text(text: str) -> bool:
    low = clean_word(text).lower().strip()

    if not low:
        return False

    return any(bad in low for bad in HALLUCINATION_BLACKLIST)


# ============================================================================
# EDIT DISTANCE
# ============================================================================

def levenshtein_ratio(a: str, b: str) -> float:
    if a == b:
        return 1.0

    if not a or not b:
        return 0.0

    if abs(len(a) - len(b)) > max(len(a), len(b)) // 2:
        return 0.0

    previous = list(range(len(b) + 1))

    for i, ca in enumerate(a, 1):
        current = [i]

        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1

            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost,
                )
            )

        previous = current

    distance = previous[-1]

    return 1.0 - distance / max(len(a), len(b))


# ============================================================================
# LEXICAL MATCHING
# ============================================================================

def stem_like(word: str) -> str:
    """
    Conservative pronunciation/stem representation.

    Designed specifically for singing:
        going -> goin
        believing -> believin
        running -> runnin
    """

    w = normalize_for_match(word)

    if len(w) > 4 and w.endswith("ing"):
        return w[:-1]

    if len(w) > 4 and w.endswith("in"):
        return w + "g"

    return w


def contraction_compatible(a: str, b: str) -> bool:
    a = normalize_for_match(a)
    b = normalize_for_match(b)

    if a == b:
        return True

    if a in CONTRACTION_MAP and b in CONTRACTION_MAP[a]:
        return True

    if b in CONTRACTION_MAP and a in CONTRACTION_MAP[b]:
        return True

    return False


def vocalization_compatible(a: str, b: str) -> bool:
    a = normalize_for_match(a)
    b = normalize_for_match(b)

    for key, group in VOCALIZATION_EQUIV.items():
        members = {normalize_for_match(key)}
        members.update(normalize_for_match(x) for x in group)

        if a in members and b in members:
            return True

    return False


def match_score(
    canonical_word: str,
    whisper_word: str,
) -> Tuple[float, str]:
    """
    Returns:

        (score, category)

    Score:
        > 0 = acceptable lexical match
        <= 0 = reject
    """

    c_raw = clean_word(canonical_word)
    w_raw = clean_word(whisper_word)

    if not c_raw or not w_raw:
        return -4.0, "UNMATCHED"

    # Strongest possible match.
    if c_raw.lower() == w_raw.lower():
        return 5.0, "EXACT"

    c = normalize_for_match(c_raw)
    w = normalize_for_match(w_raw)

    if not c or not w:
        return -4.0, "UNMATCHED"

    # Punctuation/case variation.
    if c == w:
        return 4.5, "NORMALIZED"

    # Contraction compatibility.
    if contraction_compatible(c, w):
        return 3.7, "CONTRACTION"

    # Singing pronunciation.
    if stem_like(c) == stem_like(w):
        return 3.25, "PRONUNCIATION"

    # Vocalisations.
    if vocalization_compatible(c, w):
        return 3.0, "VOCALIZATION"

    # Strong fuzzy match.
    if len(c) >= 3 and len(w) >= 3:
        ratio = levenshtein_ratio(c, w)

        if ratio >= 0.88:
            return 2.9, "FUZZY_STRONG"

        if ratio >= 0.78:
            return 2.1, "FUZZY"

        # Weak fuzzy matches are deliberately rejected in v2.
        # They caused too many repeated-word false positives.
    
    return -4.0, "UNMATCHED"


# ============================================================================
# CANONICAL PARSER
# ============================================================================

def parse_canonical_lyrics(
    lyrics_input,
    total_duration: float = 180.0,
):
    if isinstance(lyrics_input, list):

        if lyrics_input and isinstance(lyrics_input[0], list):

            lines = []

            step = max(
                2.0,
                min(
                    5.0,
                    (total_duration - 4.0) /
                    max(1, len(lyrics_input)),
                ),
            )

            for idx, word_list in enumerate(lyrics_input):

                text = " ".join(str(x) for x in word_list).strip()

                if not text:
                    continue

                t = min(
                    total_duration - 1.0,
                    1.5 + idx * step,
                )

                lines.append(
                    CanonicalLine(
                        text=text,
                        time=t,
                        source_index=idx,
                        estimated=True,
                    )
                )

            return lines, {}

        lyrics_text = "\n".join(str(x) for x in lyrics_input)

    else:
        lyrics_text = str(lyrics_input or "")

    extracted_tags = {}
    parsed_lines = []

    TAG_REGEX = re.compile(
        r"^\[([a-zA-Z]{2,10}):(.*?)\]$"
    )

    TS_REGEX = re.compile(
        r"\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]"
    )

    ELRC_WORD_TAG = re.compile(
        r"<\d{1,2}:\d{2}(?:\.\d{1,3})?>"
    )

    for src_idx, raw in enumerate(lyrics_text.splitlines()):

        line = raw.strip()

        if not line:
            continue

        tag_match = TAG_REGEX.match(line)

        if tag_match:

            name = tag_match.group(1).lower()
            value = tag_match.group(2).strip()

            if name not in {"by", "re"}:
                extracted_tags[name] = value

            continue

        timestamps = TS_REGEX.findall(line)

        text = TS_REGEX.sub("", line)
        text = ELRC_WORD_TAG.sub("", text).strip()

        if not text:
            continue

        if timestamps:

            mm, ss = timestamps[0]

            anchor = (
                int(mm) * 60.0 +
                float(ss)
            )

            parsed_lines.append(
                CanonicalLine(
                    text=text,
                    time=anchor,
                    source_index=src_idx,
                    estimated=False,
                    raw_line=line,
                )
            )

        else:

            parsed_lines.append(
                CanonicalLine(
                    text=text,
                    time=None,
                    source_index=src_idx,
                    estimated=True,
                    raw_line=line,
                )
            )

    if not parsed_lines:
        return [], extracted_tags

    # ----------------------------------------------------------------------
    # Resolve missing line anchors.
    # ----------------------------------------------------------------------

    known = [
        (idx, line.time)
        for idx, line in enumerate(parsed_lines)
        if line.time is not None
    ]

    if not known:

        step = max(
            1.5,
            min(
                4.5,
                (total_duration - 4.0) /
                max(1, len(parsed_lines)),
            ),
        )

        for i, line in enumerate(parsed_lines):

            line.time = min(
                total_duration - 1.0,
                1.5 + i * step,
            )

            line.estimated = True

    else:

        for i, line in enumerate(parsed_lines):

            if line.time is not None:
                continue

            previous = None
            following = None

            for idx, t in known:

                if idx < i:
                    previous = (idx, t)

                elif idx > i:
                    following = (idx, t)
                    break

            if previous is None:
                line.time = max(
                    0.0,
                    float(following[1]) -
                    1.5 * (following[0] - i),
                )

            elif following is None:
                line.time = float(previous[1]) + 2.0

            else:

                p_idx, p_t = previous
                n_idx, n_t = following

                ratio = (
                    (i - p_idx) /
                    max(1, n_idx - p_idx)
                )

                line.time = (
                    float(p_t) +
                    (float(n_t) - float(p_t)) * ratio
                )

            line.estimated = True

    # Final numeric sanitation.
    last = 0.0

    for line in parsed_lines:

        if line.time is None or not math.isfinite(line.time):
            line.time = last

        line.time = max(last, float(line.time))
        line.time = min(total_duration, line.time)

        last = line.time

    return parsed_lines, extracted_tags


# ============================================================================
# WHISPER CLEANUP
# ============================================================================

def prepare_whisper_words(whisper_words):
    result = []

    for item in whisper_words:

        text = clean_word(
            item.get("text") or
            item.get("word") or
            ""
        )

        if not text:
            continue

        if is_hallucination_text(text):
            continue

        try:
            start = float(item["start"])
            end = float(item["end"])
        except (KeyError, TypeError, ValueError):
            continue

        if not math.isfinite(start) or not math.isfinite(end):
            continue

        if end <= start:
            continue

        duration = end - start

        if duration < MIN_WORD_DURATION_SEC:
            continue

        if duration > MAX_SUSTAINED_WORD_SEC * 1.5:
            continue

        result.append({
            "text": text,
            "start": start,
            "end": end,
            "score": float(
                item.get("score", 1.0)
                if item.get("score") is not None
                else 1.0
            ),
        })

    result.sort(key=lambda x: (x["start"], x["end"]))

    return result


# ============================================================================
# CANONICAL FLATTENING
# ============================================================================

def flatten_canonical(lines):
    result = []

    global_idx = 0

    for line_idx, line in enumerate(lines):

        for word_idx, text in enumerate(line.words):

            result.append(
                CanonicalWord(
                    original_text=text,
                    line_idx=line_idx,
                    word_idx_in_line=word_idx,
                    global_idx=global_idx,
                    line_anchor=line.time,
                    is_estimated=line.estimated,
                )
            )

            global_idx += 1

    return result


# ============================================================================
# TEMPORAL SCORING
# ============================================================================

def temporal_score(
    canonical: CanonicalWord,
    whisper,
    previous_whisper,
):
    """
    Score temporal plausibility.

    A lexical match at the correct part of the song gets a bonus.

    A repeated word many seconds away gets heavily penalised.
    """

    if canonical.line_anchor is None:
        anchor_score = 0.0

    else:

        drift = abs(
            float(whisper["start"]) -
            float(canonical.line_anchor)
        )

        if drift > MAX_ANCHOR_DRIFT_HARD_SEC:
            return -100.0

        anchor_score = max(
            -2.5,
            1.5 - 0.10 * drift
        )

    continuity = 0.0

    if previous_whisper is not None:

        gap = (
            float(whisper["start"]) -
            float(previous_whisper["end"])
        )

        # Negative means impossible backwards movement.
        if gap < -0.10:
            return -100.0

        if gap <= MAX_INTRA_LINE_JUMP_SEC:
            continuity += (
                1.0 -
                min(1.0, gap /
                    MAX_INTRA_LINE_JUMP_SEC)
            ) * TEMPORAL_CONTINUITY_WEIGHT

        else:
            continuity -= min(
                2.0,
                (gap - MAX_INTRA_LINE_JUMP_SEC) *
                0.35
            )

    return anchor_score + continuity


# ============================================================================
# LOCAL CANDIDATE SEARCH
# ============================================================================

def candidate_whisper_indices(
    canonical: CanonicalWord,
    whisper_words,
):
    """
    Restrict candidate matches to a local temporal region.

    This is one of the major v2 improvements.

    It prevents a common word such as:
        I
        you
        the
        love

    from matching an identical occurrence 40 seconds away.
    """

    if not whisper_words:
        return []

    anchor = canonical.line_anchor

    if anchor is None:
        return range(len(whisper_words))

    # Wider window for estimated anchors.
    window = (
        9.0
        if canonical.is_estimated
        else 7.0
    )

    starts = [w["start"] for w in whisper_words]

    left = bisect.bisect_left(
        starts,
        anchor - window
    )

    right = bisect.bisect_right(
        starts,
        anchor + window
    )

    return range(left, right)


# ============================================================================
# V2 MONOTONIC DP
# ============================================================================

def align_canonical_sequence_v2(
    canonical_words,
    whisper_words,
):
    """
    Canonical-first monotonic alignment.

    Unlike the original engine, v2 does not allow every canonical word
    to freely compete against every Whisper occurrence.

    Candidate matching is constrained by:
        - lexical compatibility
        - temporal anchor
        - previous matched occurrence
        - local temporal windows
        - repeated-word penalties
    """

    N = len(canonical_words)
    M = len(whisper_words)

    if N == 0:
        return {}

    if M == 0:
        return {i: None for i in range(N)}

    # ----------------------------------------------------------------------
    # DP state.
    #
    # We retain a classic global sequence DP but calculate much stronger
    # match scores.
    # ----------------------------------------------------------------------

    dp = [
        [0.0] * (M + 1)
        for _ in range(N + 1)
    ]

    back = [
        [2] * (M + 1)
        for _ in range(N + 1)
    ]

    # Base conditions.
    for i in range(1, N + 1):

        dp[i][0] = (
            dp[i - 1][0] +
            CANONICAL_SKIP_PENALTY
        )

        back[i][0] = 1

    for j in range(1, M + 1):

        dp[0][j] = (
            dp[0][j - 1] +
            WHISPER_SKIP_PENALTY
        )

        back[0][j] = 2

    # ----------------------------------------------------------------------
    # Pre-compute local candidates.
    # ----------------------------------------------------------------------

    candidate_sets = {}

    for i, c in enumerate(canonical_words):

        candidate_sets[i] = set(
            candidate_whisper_indices(
                c,
                whisper_words,
            )
        )

    # ----------------------------------------------------------------------
    # DP.
    # ----------------------------------------------------------------------

    for i in range(1, N + 1):

        canonical = canonical_words[i - 1]

        for j in range(1, M + 1):

            whisper = whisper_words[j - 1]

            # --------------------------------------------------------------
            # Option 1: skip canonical.
            # --------------------------------------------------------------

            best = (
                dp[i - 1][j] +
                CANONICAL_SKIP_PENALTY
            )

            direction = 1

            # --------------------------------------------------------------
            # Option 2: skip Whisper insertion.
            # --------------------------------------------------------------

            skip_w = (
                dp[i][j - 1] +
                WHISPER_SKIP_PENALTY
            )

            if skip_w > best:

                best = skip_w
                direction = 2

            # --------------------------------------------------------------
            # Option 3: lexical match.
            # --------------------------------------------------------------

            if j - 1 in candidate_sets[i - 1]:

                lexical, category = match_score(
                    canonical.original_text,
                    whisper["text"],
                )

                if lexical > 0:

                    previous_whisper = None

                    # Approximate previous anchor using immediate
                    # predecessor in the DP path.
                    if i > 1 and j > 1:

                        prev_idx = back[i - 1][j - 1]

                        if prev_idx == 0:
                            previous_whisper = whisper_words[j - 2]

                    temporal = temporal_score(
                        canonical,
                        whisper,
                        previous_whisper,
                    )

                    if temporal > -50:

                        # Repeated/common words receive less benefit
                        # from weak matches.
                        norm = normalize_for_match(
                            canonical.original_text
                        )

                        common_penalty = (
                            0.30
                            if norm in COMMON_WORDS
                            and category not in {
                                "EXACT",
                                "NORMALIZED",
                            }
                            else 0.0
                        )

                        score = (
                            lexical +
                            temporal -
                            common_penalty
                        )

                        candidate = (
                            dp[i - 1][j - 1] +
                            score
                        )

                        if (
                            score >= MIN_ANCHOR_SCORE
                            and candidate > best
                        ):

                            best = candidate
                            direction = 0

            dp[i][j] = best
            back[i][j] = direction

    # ----------------------------------------------------------------------
    # Backtrack.
    # ----------------------------------------------------------------------

    alignment = {
        i: None
        for i in range(N)
    }

    i = N
    j = M

    while i > 0 and j > 0:

        direction = back[i][j]

        if direction == 0:

            alignment[i - 1] = j - 1

            i -= 1
            j -= 1

        elif direction == 1:

            i -= 1

        else:

            j -= 1

    return alignment


# ============================================================================
# POST-DP ANCHOR VALIDATION
# ============================================================================

def validate_alignment(
    canonical_words,
    whisper_words,
    alignment,
):
    """
    Second-pass validation.

    Removes suspicious matches that survived DP but violate local timing.
    """

    previous_idx = None

    for i in range(len(canonical_words)):

        w_idx = alignment.get(i)

        if w_idx is None:
            continue

        if previous_idx is not None:

            if w_idx <= previous_idx:

                alignment[i] = None
                continue

            prev = whisper_words[previous_idx]
            curr = whisper_words[w_idx]

            gap = (
                curr["start"] -
                prev["end"]
            )

            if gap < -0.10:

                alignment[i] = None
                continue

            # Large unexplained jump.
            if (
                gap > MAX_INTRA_LINE_JUMP_SEC
                and canonical_words[i].line_idx ==
                canonical_words[
                    max(0, i - 1)
                ].line_idx
            ):

                # Common words are particularly dangerous here.
                norm = normalize_for_match(
                    canonical_words[i].original_text
                )

                if norm in COMMON_WORDS:

                    alignment[i] = None
                    continue

        previous_idx = alignment.get(i)

    return alignment


# ============================================================================
# TIMING SANITISATION
# ============================================================================

def safe_float(value, fallback=0.0):
    try:

        result = float(value)

        if math.isfinite(result):
            return result

    except (TypeError, ValueError):
        pass

    return float(fallback)


def clamp_word_duration(
    start,
    end,
):
    start = max(0.0, safe_float(start))
    end = safe_float(end, start + MIN_WORD_DURATION_SEC)

    if end <= start:
        end = start + MIN_WORD_DURATION_SEC

    duration = end - start

    if duration > MAX_SUSTAINED_WORD_SEC:

        end = start + MAX_SUSTAINED_WORD_SEC

    return start, end


# ============================================================================
# TIMING RECONCILIATION
# ============================================================================

def reconcile_and_refine_timings_v2(
    canonical_lines,
    canonical_words,
    alignment_map,
    whisper_words,
    total_duration,
):
    """
    Convert canonical + Whisper alignment into complete word timings.

    Important:
        Every canonical word receives a numeric timestamp.

    Matched words:
        use WhisperX evidence.

    Unmatched words:
        interpolate between reliable matched anchors.

    No canonical word is ever removed.
    """

    raw = []

    for idx, canonical in enumerate(canonical_words):

        w_idx = alignment_map.get(idx)

        if w_idx is not None:

            whisper = whisper_words[w_idx]

            start, end = clamp_word_duration(
                whisper["start"],
                whisper["end"],
            )

            raw.append({
                "word": canonical.original_text,
                "start": start,
                "end": end,
                "score": safe_float(
                    whisper.get("score", 1.0),
                    1.0,
                ),
                "matched": True,
                "line_idx": canonical.line_idx,
                "word_idx_in_line":
                    canonical.word_idx_in_line,
                "global_idx": idx,
                "whisper_idx": w_idx,
            })

        else:

            raw.append({
                "word": canonical.original_text,
                "start": None,
                "end": None,
                "score": 0.0,
                "matched": False,
                "line_idx": canonical.line_idx,
                "word_idx_in_line":
                    canonical.word_idx_in_line,
                "global_idx": idx,
                "whisper_idx": None,
            })

    # Group by canonical line.
    groups = [
        []
        for _ in canonical_lines
    ]

    for word in raw:

        if (
            0 <= word["line_idx"] <
            len(groups)
        ):
            groups[word["line_idx"]].append(word)

    output = []

    previous_line_end = 0.0

    # ======================================================================
    # Process each canonical line independently.
    # ======================================================================

    for line_idx, line in enumerate(canonical_lines):

        words = groups[line_idx]

        if not words:
            continue

        line_anchor = safe_float(
            line.time,
            previous_line_end,
        )

        # Find the next reliable canonical line anchor.
        next_anchor = total_duration

        for future in canonical_lines[line_idx + 1:]:

            if future.time is not None:

                candidate = safe_float(
                    future.time,
                    total_duration,
                )

                if candidate >= line_anchor:

                    next_anchor = candidate
                    break

        # --------------------------------------------------------------
        # Reliable matched anchors.
        # --------------------------------------------------------------

        anchors = [
            i
            for i, word in enumerate(words)
            if (
                word["matched"]
                and word["start"] is not None
                and word["end"] is not None
            )
        ]

        # --------------------------------------------------------------
        # Remove local timing outliers.
        # --------------------------------------------------------------

        if len(anchors) >= 2:

            changed = True

            while changed:

                changed = False

                anchors = [
                    i
                    for i, word in enumerate(words)
                    if (
                        word["matched"]
                        and word["start"] is not None
                        and word["end"] is not None
                    )
                ]

                for a, b in zip(
                    anchors,
                    anchors[1:],
                ):

                    t1 = words[a]["start"]
                    t2 = words[b]["start"]

                    if (
                        t1 is None
                        or t2 is None
                    ):
                        continue

                    gap = t2 - t1

                    if gap <= 0:
                        words[b]["matched"] = False
                        words[b]["start"] = None
                        words[b]["end"] = None
                        changed = True
                        break

                    distance = b - a

                    if (
                        gap >
                        MAX_INTRA_LINE_JUMP_SEC *
                        distance
                    ):

                        # Prefer the anchor closest to line anchor.
                        d1 = abs(t1 - line_anchor)
                        d2 = abs(t2 - line_anchor)

                        if d2 > d1:

                            words[b]["matched"] = False
                            words[b]["start"] = None
                            words[b]["end"] = None

                        else:

                            words[a]["matched"] = False
                            words[a]["start"] = None
                            words[a]["end"] = None

                        changed = True
                        break

        # Recalculate anchors after rejection.
        anchors = [
            i
            for i, word in enumerate(words)
            if (
                word["matched"]
                and word["start"] is not None
                and word["end"] is not None
            )
        ]

        # ==================================================================
        # NO ANCHORS
        # ==================================================================

        if not anchors:

            start = max(
                previous_line_end +
                MIN_PAUSE_GAP_SEC,
                line_anchor,
            )

            end_limit = max(
                start +
                DEFAULT_FALLBACK_WORD_DUR *
                len(words),
                next_anchor,
            )

            available = max(
                DEFAULT_FALLBACK_WORD_DUR *
                len(words),
                end_limit - start,
            )

            step = min(
                0.60,
                max(
                    MIN_WORD_DURATION_SEC * 2,
                    available /
                    max(1, len(words)),
                ),
            )

            for i, word in enumerate(words):

                s = (
                    start +
                    i * step
                )

                e = (
                    s +
                    max(
                        MIN_WORD_DURATION_SEC,
                        step * 0.82,
                    )
                )

                word["start"] = s
                word["end"] = e

        # ==================================================================
        # ANCHORS EXIST
        # ==================================================================

        else:

            # --------------------------------------------------------------
            # Leading words.
            # --------------------------------------------------------------

            first = anchors[0]

            if first > 0:

                anchor_time = words[first]["start"]

                available = max(
                    0.10,
                    anchor_time -
                    max(
                        previous_line_end,
                        line_anchor - 1.2,
                    ),
                )

                step = min(
                    0.45,
                    max(
                        MIN_WORD_DURATION_SEC * 2,
                        available /
                        (first + 1),
                    ),
                )

                start = max(
                    previous_line_end +
                    MIN_PAUSE_GAP_SEC,
                    anchor_time -
                    step * first,
                )

                for i in range(first):

                    s = (
                        start +
                        i * step
                    )

                    e = min(
                        anchor_time -
                        MIN_PAUSE_GAP_SEC,
                        s +
                        max(
                            MIN_WORD_DURATION_SEC,
                            step * 0.80,
                        ),
                    )

                    word = words[i]

                    word["start"] = s
                    word["end"] = max(
                        e,
                        s +
                        MIN_WORD_DURATION_SEC,
                    )

            # --------------------------------------------------------------
            # Between anchors.
            # --------------------------------------------------------------

            for left, right in zip(
                anchors,
                anchors[1:],
            ):

                missing = right - left - 1

                if missing <= 0:
                    continue

                left_end = words[left]["end"]
                right_start = words[right]["start"]

                if (
                    left_end is None
                    or right_start is None
                ):
                    continue

                available = max(
                    0.0,
                    right_start -
                    left_end,
                )

                if (
                    available >=
                    MIN_WORD_DURATION_SEC *
                    2 *
                    missing
                ):

                    step = (
                        available /
                        (missing + 1)
                    )

                    for k in range(
                        1,
                        missing + 1,
                    ):

                        idx = left + k

                        s = (
                            left_end +
                            step * (k - 0.5)
                        )

                        e = (
                            s +
                            max(
                                MIN_WORD_DURATION_SEC,
                                step * 0.75,
                            )
                        )

                        if e >= right_start:

                            e = max(
                                s +
                                MIN_WORD_DURATION_SEC,
                                right_start -
                                MIN_PAUSE_GAP_SEC,
                            )

                        words[idx]["start"] = s
                        words[idx]["end"] = e

                else:

                    # Extremely compressed singing.
                    step = max(
                        MIN_WORD_DURATION_SEC,
                        available /
                        (missing + 1)
                        if available > 0
                        else MIN_WORD_DURATION_SEC,
                    )

                    for k in range(
                        1,
                        missing + 1,
                    ):

                        idx = left + k

                        s = (
                            left_end +
                            step * (k - 1)
                        )

                        e = (
                            s +
                            MIN_WORD_DURATION_SEC
                        )

                        words[idx]["start"] = s
                        words[idx]["end"] = e

            # --------------------------------------------------------------
            # Trailing words.
            # --------------------------------------------------------------

            last = anchors[-1]

            if last < len(words) - 1:

                base = words[last]["end"]

                remaining = (
                    len(words) -
                    last -
                    1
                )

                available = max(
                    DEFAULT_FALLBACK_WORD_DUR *
                    remaining,
                    next_anchor -
                    base,
                )

                step = min(
                    0.45,
                    max(
                        MIN_WORD_DURATION_SEC * 2,
                        available /
                        (remaining + 1),
                    ),
                )

                for k in range(
                    1,
                    remaining + 1,
                ):

                    idx = last + k

                    s = (
                        base +
                        step * (k - 1) +
                        0.025
                    )

                    e = (
                        s +
                        max(
                            MIN_WORD_DURATION_SEC,
                            step * 0.78,
                        )
                    )

                    words[idx]["start"] = s
                    words[idx]["end"] = e

        # ==================================================================
        # FINAL WITHIN-LINE SANITISATION
        # ==================================================================

        for i, word in enumerate(words):

            fallback = (
                words[i - 1]["end"]
                if i > 0
                else max(
                    previous_line_end,
                    line_anchor,
                )
            )

            start = safe_float(
                word.get("start"),
                fallback,
            )

            end = safe_float(
                word.get("end"),
                start +
                DEFAULT_FALLBACK_WORD_DUR,
            )

            if i > 0:

                previous = words[i - 1]

                start = max(
                    start,
                    safe_float(
                        previous["start"],
                        start,
                    ),
                )

                if start < previous["end"]:

                    previous["end"] = max(
                        previous["start"] +
                        MIN_WORD_DURATION_SEC,
                        start -
                        MIN_PAUSE_GAP_SEC,
                    )

            start, end = clamp_word_duration(
                start,
                end,
            )

            word["start"] = round(
                start,
                3,
            )

            word["end"] = round(
                end,
                3,
            )

        # ==================================================================
        # CROSS-LINE SANITISATION
        # ==================================================================

        if output:

            previous_segment = output[-1]

            previous_last = (
                previous_segment["words"][-1]
            )

            current_first = words[0]

            if (
                current_first["start"] <
                previous_last["start"]
            ):

                current_first["start"] = (
                    previous_last["start"] +
                    MIN_PAUSE_GAP_SEC
                )

            if (
                previous_last["end"] >
                current_first["start"]
            ):

                previous_last["end"] = max(
                    previous_last["start"] +
                    MIN_WORD_DURATION_SEC,
                    current_first["start"] -
                    MIN_PAUSE_GAP_SEC,
                )

                previous_segment["end"] = (
                    previous_last["end"]
                )

        seg_start = words[0]["start"]
        seg_end = words[-1]["end"]

        seg_start = max(
            0.0,
            safe_float(seg_start),
        )

        seg_end = max(
            seg_start +
            MIN_WORD_DURATION_SEC,
            safe_float(
                seg_end,
                seg_start +
                MIN_WORD_DURATION_SEC,
            ),
        )

        previous_line_end = seg_end

        output.append({
            "start": round(seg_start, 3),
            "end": round(seg_end, 3),
            "text": " ".join(
                word["word"]
                for word in words
            ),
            "words": words,
        })

    return output


# ============================================================================
# MUSIC GAP DETECTION
# ============================================================================

def insert_music_markers(
    segments,
):
    if not segments:
        return []

    result = []

    for i, current in enumerate(segments):

        result.append(current)

        if i >= len(segments) - 1:
            continue

        following = segments[i + 1]

        current_end = safe_float(
            current["end"]
        )

        next_start = safe_float(
            following["start"]
        )

        gap = next_start - current_end

        if gap >= MUSIC_GAP_SEC:

            marker_start = round(
                current_end + 0.5,
                2,
            )

            marker_end = round(
                next_start - 0.5,
                2,
            )

            if marker_end > marker_start:

                result.append({
                    "start": marker_start,
                    "end": marker_end,
                    "text": "[MUSIC]",
                    "words": [{
                        "word": "[MUSIC]",
                        "start": marker_start,
                        "end": marker_end,
                        "score": 1.0,
                    }],
                })

    return result


# ============================================================================
# MAIN RECONCILIATION API
# ============================================================================

def reconcile_and_align_lyrics(
    lyrics_input,
    whisper_words,
    total_duration=180.0,
    tags=None,
):
    canonical_lines, extracted_tags = (
        parse_canonical_lyrics(
            lyrics_input,
            total_duration,
        )
    )

    if tags is not None and isinstance(tags, dict):

        tags.update(extracted_tags)

    # ----------------------------------------------------------------------
    # No canonical lyrics.
    # ----------------------------------------------------------------------

    if not canonical_lines:

        if not whisper_words:
            return []

        words = []

        for w in whisper_words:

            start, end = clamp_word_duration(
                w["start"],
                w["end"],
            )

            words.append({
                "word": clean_word(
                    w.get("text") or
                    w.get("word") or
                    ""
                ),
                "start": start,
                "end": end,
                "score": safe_float(
                    w.get("score", 1.0),
                    1.0,
                ),
            })

        if not words:
            return []

        return [{
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "text": " ".join(
                w["word"]
                for w in words
            ),
            "words": words,
        }]

    # ----------------------------------------------------------------------
    # Clean Whisper evidence.
    # ----------------------------------------------------------------------

    valid_whisper = prepare_whisper_words(
        whisper_words
    )

    canonical_words = flatten_canonical(
        canonical_lines
    )

    log(
        "INFO",
        "V2 canonical alignment: "
        f"{len(canonical_lines)} lines / "
        f"{len(canonical_words)} canonical words "
        f"against {len(valid_whisper)} "
        "WhisperX timing tokens",
    )

    # ----------------------------------------------------------------------
    # V2 alignment.
    # ----------------------------------------------------------------------

    alignment = align_canonical_sequence_v2(
        canonical_words,
        valid_whisper,
    )

    alignment = validate_alignment(
        canonical_words,
        valid_whisper,
        alignment,
    )

    matched = sum(
        1
        for idx in alignment
        if alignment[idx] is not None
    )

    log(
        "INFO",
        f"V2 sequence alignment matched "
        f"{matched}/{len(canonical_words)} "
        "canonical words",
    )

    # ----------------------------------------------------------------------
    # Timing reconstruction.
    # ----------------------------------------------------------------------

    segments = reconcile_and_refine_timings_v2(
        canonical_lines,
        canonical_words,
        alignment,
        valid_whisper,
        total_duration,
    )

    # ----------------------------------------------------------------------
    # Music gaps.
    # ----------------------------------------------------------------------

    result = insert_music_markers(
        segments
    )

    music_count = sum(
        1
        for segment in result
        if segment.get("text") == "[MUSIC]"
    )

    if music_count:

        log(
            "INFO",
            f"inserted {music_count} "
            f"[MUSIC] marker(s)",
        )

    return result


# ============================================================================
# PHASE 0
# ============================================================================

def separate_vocals(
    audio_path,
    device,
):
    progress(
        5,
        "PHASE 0 -- Demucs vocal isolation",
    )

    log(
        "INFO",
        "loading Demucs htdemucs",
    )

    try:
        import demucs.separate

    except ImportError as exc:

        log(
            "WARN",
            f"demucs not installed ({exc}); "
            "using original audio",
        )

        return audio_path

    src_dir = (
        os.path.dirname(
            os.path.abspath(audio_path)
        )
        or "."
    )

    base = os.path.splitext(
        os.path.basename(audio_path)
    )[0]

    out_root = src_dir

    expected = os.path.join(
        out_root,
        "htdemucs",
        base,
        "vocals.wav",
    )

    args = [
        "--two-stems=vocals",
        "-n",
        "htdemucs",
        "-o",
        out_root,
        "--device",
        device,
        audio_path,
    ]

    progress(
        8,
        f"PHASE 0 -- separating vocals "
        f"from {os.path.basename(audio_path)}",
    )

    started = time.time()

    try:
        demucs.separate.main(args)

    except SystemExit:
        pass

    except Exception as exc:

        log(
            "WARN",
            f"Demucs failed ({exc}); "
            "using original audio",
        )

        log(
            "WARN",
            traceback.format_exc(),
        )

        return audio_path

    if not os.path.exists(expected):

        log(
            "WARN",
            f"vocals stem not found at {expected}",
        )

        return audio_path

    try:

        import shutil

        nice_path = os.path.join(
            src_dir,
            f"{base}_vocals.wav",
        )

        shutil.copyfile(
            expected,
            nice_path,
        )

        log(
            "INFO",
            f"vocals stem saved to {nice_path}",
        )

        log(
            "INFO",
            f"PHASE 0 done in "
            f"{time.time() - started:.1f}s",
        )

        return nice_path

    except Exception:

        return expected


# ============================================================================
# PHASE 1
# ============================================================================

def transcribe_streaming(
    audio_path,
    language,
    device,
    compute_type,
):
    progress(
        15,
        "PHASE 1 -- loading faster-whisper large-v2",
    )

    try:

        from faster_whisper import WhisperModel

    except ImportError as exc:

        log(
            "ERR ",
            f"faster-whisper not installed: {exc}",
        )

        return None, 0.0

    started = time.time()

    model = WhisperModel(
        "large-v2",
        device=device,
        compute_type=compute_type,
    )

    log(
        "INFO",
        f"Whisper loaded in "
        f"{time.time() - started:.1f}s",
    )

    progress(
        20,
        "PHASE 1 -- transcribing vocal stem",
    )

    segments_iter, info = model.transcribe(
        audio_path,
        language=(
            None
            if language == "auto"
            else language
        ),
        beam_size=5,
        vad_filter=False,
        word_timestamps=False,
        no_speech_threshold=0.6,
        condition_on_previous_text=False,
    )

    duration = (
        float(info.duration)
        if info.duration
        else 1.0
    )

    log(
        "INFO",
        f"audio {duration:.1f}s; "
        f"language={info.language}; "
        f"prob={info.language_probability:.2f}",
    )

    segments = []

    started = time.time()

    for segment in segments_iter:

        item = {
            "start": float(segment.start),
            "end": float(segment.end),
            "text": segment.text,
        }

        segments.append(item)

        seg_event(
            segment.start,
            segment.end,
            segment.text,
        )

        pct = (
            20 +
            int(
                40 *
                (
                    segment.end /
                    max(duration, 1.0)
                )
            )
        )

        progress(
            min(60, pct),
            "PHASE 1 -- transcription",
        )

    log(
        "INFO",
        f"PHASE 1 done in "
        f"{time.time() - started:.1f}s "
        f"({len(segments)} segments)",
    )

    del model

    try:

        import torch

        if device == "cuda":
            torch.cuda.empty_cache()

    except ImportError:
        pass

    return segments, duration


# ============================================================================
# eLRC FORMATTER
# ============================================================================

def fmt_ts(t):
    t = max(
        0.0,
        safe_float(t),
    )

    total_cs = round(
        t * 100
    )

    minutes = total_cs // 6000
    seconds = (
        total_cs // 100
    ) % 60
    centiseconds = (
        total_cs % 100
    )

    return (
        f"{minutes:02d}:"
        f"{seconds:02d}."
        f"{centiseconds:02d}"
    )


def format_elrc(
    output_segments,
    tags=None,
):
    tags = tags or {}

    lines = []

    title = (
        tags.get("title")
        or tags.get("ti")
    )

    artist = (
        tags.get("artist")
        or tags.get("ar")
    )

    album = (
        tags.get("album")
        or tags.get("al")
    )

    if title:
        lines.append(
            f"[ti:{title}]"
        )

    if artist:
        lines.append(
            f"[ar:{artist}]"
        )

    if album:
        lines.append(
            f"[al:{album}]"
        )

    # Immutable Yimly metadata.
    lines.append(
        "[by:Yimly Sync]"
    )

    lines.append(
        "[re:Yimly Sync (whisperx)]"
    )

    lines.append("")

    for segment in output_segments:

        words = []

        for word in segment.get(
            "words",
            [],
        ):

            start = word.get("start")
            end = word.get("end")

            if start is None or end is None:
                continue

            words.append({
                "word": clean_word(
                    word.get("word", "")
                ),
                "start": safe_float(start),
                "end": safe_float(end),
            })

        if not words:
            continue

        parts = [
            f"[{fmt_ts(words[0]['start'])}]"
        ]

        for word in words:

            parts.append(
                f"<{fmt_ts(word['start'])}>"
                f"{word['word']}"
            )

        parts.append(
            f"<{fmt_ts(words[-1]['end'])}>"
        )

        lines.append(
            " ".join(parts)
        )

    return "\n".join(lines) + "\n"


# ============================================================================
# MAIN
# ============================================================================

def main():

    parser = argparse.ArgumentParser()

    parser.add_argument(
        "request"
    )

    parser.add_argument(
        "status",
        nargs="?",
    )

    args = parser.parse_args()

    with open(
        args.request,
        "r",
        encoding="utf-8",
    ) as handle:

        request = json.load(handle)

    audio_path = request["audio"]

    vocals_path = request.get(
        "vocals"
    )

    lyrics = request.get(
        "lyrics",
        "",
    )

    language = (
        request.get("language")
        or "en"
    ).lower()

    if language == "auto":
        language = "en"

    use_gpu = bool(
        request.get(
            "use_gpu",
            True,
        )
    )

    output = request["output"]

    tags = (
        request.get("tags", {})
        or {}
    )

    split_vocals = bool(
        request.get(
            "split_vocals",
            False,
        )
    )

    progress(
        1,
        "loading torch + whisperx",
    )

    try:

        import torch
        import whisperx

    except ImportError as exc:

        log(
            "ERR ",
            f"missing dependency: {exc}",
        )

        if args.status:

            Path(
                args.status
            ).write_text(
                json.dumps({
                    "ok": False,
                    "error": str(exc),
                }),
                encoding="utf-8",
            )

        sys.exit(1)

    # ----------------------------------------------------------------------
    # MANDATORY CUDA VALIDATION - NO CPU FALLBACK (device='cpu' / compute_type='int8' DISABLED)
    # ----------------------------------------------------------------------
    cuda_valid = False
    cuda_err_detail = ""
    dev_name = ""
    vram_gb = 0.0

    try:
        if not torch.cuda.is_available():
            raise RuntimeError("torch.cuda.is_available() returned False")
        if torch.cuda.device_count() < 1:
            raise RuntimeError("torch.cuda.device_count() is 0")
        dev_name = torch.cuda.get_device_name(0)
        vram_gb = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2)
        
        # Real CUDA tensor execution
        test_x = torch.ones((256, 256), device="cuda", dtype=torch.float32)
        test_y = torch.matmul(test_x, test_x)
        torch.cuda.synchronize()
        del test_x, test_y
        torch.cuda.empty_cache()
        cuda_valid = True
    except Exception as c_exc:
        cuda_valid = False
        cuda_err_detail = str(c_exc)

    if not cuda_valid:
        fail_msg = "CUDA/RTX 3060 is required for audio separation but is unavailable."
        log("ERR ", fail_msg)
        if cuda_err_detail:
            log("ERR ", f"Diagnostic detail: {cuda_err_detail}")
        log("ERR ", "CPU fallback (device='cpu', compute_type='int8') is strictly disabled.")
        if args.status:
            Path(args.status).write_text(
                json.dumps({
                    "ok": False,
                    "error": fail_msg,
                    "cuda_error": cuda_err_detail,
                    "device": "cuda",
                }),
                encoding="utf-8",
            )
        sys.exit(1)

    device = "cuda"
    compute_type = "float16"

    log(
        "INFO",
        f"Audio device: CUDA — {dev_name} ({vram_gb} GB VRAM)",
    )
    log(
        "INFO",
        "CUDA compute validated with compute_type='float16'. CPU fallback disabled.",
    )

    # ======================================================================
    # PHASE 0
    # ======================================================================

    transcription_audio = audio_path

    if (
        vocals_path
        and os.path.exists(vocals_path)
    ):

        transcription_audio = vocals_path

        log(
            "INFO",
            f"using provided vocals stem: "
            f"{transcription_audio}",
        )

    elif split_vocals:

        transcription_audio = separate_vocals(
            audio_path,
            device,
        )

    # ======================================================================
    # PHASE 1
    # ======================================================================

    segments, duration = transcribe_streaming(
        transcription_audio,
        language,
        device,
        compute_type,
    )

    if not segments:

        log(
            "ERR ",
            "transcription failed or yielded no segments",
        )

        if args.status:

            Path(
                args.status
            ).write_text(
                json.dumps({
                    "ok": False,
                    "error": "transcription failed",
                }),
                encoding="utf-8",
            )

        sys.exit(1)

    # ======================================================================
    # PHASE 2
    # ======================================================================

    progress(
        62,
        "loading vocal audio for alignment",
    )

    audio = whisperx.load_audio(
        transcription_audio
    )

    progress(
        65,
        "PHASE 2 -- loading wav2vec2",
    )

    try:

        align_model, metadata = (
            whisperx.load_align_model(
                language_code=language,
                device=device,
            )
        )

    except Exception as exc:

        log(
            "ERR ",
            f"load_align_model({language}) failed: {exc}",
        )

        if args.status:

            Path(
                args.status
            ).write_text(
                json.dumps({
                    "ok": False,
                    "error": str(exc),
                }),
                encoding="utf-8",
            )

        sys.exit(1)

    progress(
        70,
        "PHASE 2 -- CTC forced alignment",
    )

    started = time.time()

    try:

        aligned = whisperx.align(
            segments,
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )

    except Exception as exc:

        log(
            "ERR ",
            f"WhisperX alignment failed: {exc}",
        )

        log(
            "ERR ",
            traceback.format_exc(),
        )

        if args.status:

            Path(
                args.status
            ).write_text(
                json.dumps({
                    "ok": False,
                    "error": str(exc),
                }),
                encoding="utf-8",
            )

        sys.exit(1)

    aligned_segments = aligned["segments"]

    aligned_word_count = sum(
        len(
            segment.get(
                "words",
                [],
            )
        )
        for segment in aligned_segments
    )

    log(
        "INFO",
        f"PHASE 2 done in "
        f"{time.time() - started:.1f}s "
        f"({aligned_word_count} timed words)",
    )

    # ======================================================================
    # PHASE 3
    # ======================================================================

    progress(
        85,
        "PHASE 3 -- canonical-first v2 reconciliation",
    )

    if not lyrics.strip():

        log(
            "INFO",
            "no canonical lyrics; "
            "using WhisperX transcription",
        )

        output_segments = aligned_segments

    else:

        whisper_words = []

        for segment in aligned_segments:

            for word in segment.get(
                "words",
                [],
            ):

                text = clean_word(
                    word.get("word")
                    or word.get("text")
                    or ""
                )

                if (
                    not text
                    or "start" not in word
                    or "end" not in word
                ):
                    continue

                whisper_words.append({
                    "text": text,
                    "start": float(
                        word["start"]
                    ),
                    "end": float(
                        word["end"]
                    ),
                    "score": float(
                        word.get(
                            "score",
                            1.0,
                        )
                        if word.get("score")
                        is not None
                        else 1.0
                    ),
                })

        log(
            "INFO",
            f"WhisperX supplied "
            f"{len(whisper_words)} word timings",
        )

        output_segments = (
            reconcile_and_align_lyrics(
                lyrics,
                whisper_words,
                duration,
                tags=tags,
            )
        )

        # Stream representative alignment events.
        for segment in output_segments:

            words = segment.get(
                "words",
                [],
            )

            for idx, word in enumerate(words):

                if (
                    idx == 0
                    or idx == len(words) - 1
                    or idx % 4 == 0
                ):

                    word_event(
                        word["start"],
                        word["word"],
                        word["word"],
                    )

    # ======================================================================
    # PHASE 4
    # ======================================================================

    progress(
        97,
        "PHASE 4 -- writing eLRC",
    )

    content = format_elrc(
        output_segments,
        tags=tags,
    )

    segment_count = sum(
        1
        for segment in output_segments
        if segment.get("words")
    )

    word_count = sum(
        len(
            segment.get(
                "words",
                [],
            )
        )
        for segment in output_segments
    )

    Path(output).parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with open(
        output,
        "w",
        encoding="utf-8",
        newline="\n",
    ) as handle:

        handle.write(content)

    log(
        "INFO",
        f"wrote {output} "
        f"({segment_count} segments, "
        f"{word_count} words)",
    )

    progress(
        100,
        "done",
    )

    if args.status:

        Path(
            args.status
        ).write_text(
            json.dumps({
                "ok": True,
                "output": output,
                "segments": segment_count,
                "words": word_count,
                "device": device,
                "vocals": (
                    transcription_audio
                    if (
                        vocals_path
                        or split_vocals
                    )
                    else None
                ),
                "engine": "usersync-v2",
            }),
            encoding="utf-8",
        )


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":

    try:

        main()

    except SystemExit:

        raise

    except Exception as exc:

        log(
            "ERR ",
            f"fatal: {exc}",
        )

        log(
            "ERR ",
            traceback.format_exc(),
        )

        sys.exit(2)
