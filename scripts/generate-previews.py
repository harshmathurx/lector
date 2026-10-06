#!/usr/bin/env python3
"""Generate voice preview clips for all Kokoro voices.

Uses the voicebox backend's Python environment (which has kokoro installed)
to generate short "Hi, I'm [name]" clips for every voice. Saves as MP3
in the extension's static/previews/ directory.

Usage:
    cd voicebox-extension
    python3 ../voicebox/backend/venv/bin/python scripts/generate-previews.py

    # Or directly:
    /Users/harsh.rajmathur/Desktop/harsh-builds/voicebox/backend/venv/bin/python \
        scripts/generate-previews.py
"""

import os
import sys
import json
import subprocess

VOICES = [
    # (voice_id, display_name)
    ("af_heart", "Heart"), ("af_alloy", "Alloy"), ("af_aoede", "Aoede"),
    ("af_bella", "Bella"), ("af_jessica", "Jessica"), ("af_kore", "Kore"),
    ("af_nicole", "Nicole"), ("af_nova", "Nova"), ("af_river", "River"),
    ("af_sarah", "Sarah"), ("af_sky", "Sky"),
    ("am_adam", "Adam"), ("am_echo", "Echo"), ("am_eric", "Eric"),
    ("am_fenrir", "Fenrir"), ("am_liam", "Liam"), ("am_michael", "Michael"),
    ("am_onyx", "Onyx"), ("am_puck", "Puck"), ("am_santa", "Santa"),
    ("bf_alice", "Alice"), ("bf_emma", "Emma"), ("bf_isabella", "Isabella"),
    ("bf_lily", "Lily"),
    ("bm_daniel", "Daniel"), ("bm_fable", "Fable"), ("bm_george", "George"),
    ("bm_lewis", "Lewis"),
    ("jf_alpha", "Alpha"), ("jf_gongitsune", "Gongitsune"),
    ("jf_nezumi", "Nezumi"), ("jf_tebukuro", "Tebukuro"), ("jm_kumo", "Kumo"),
    ("zf_xiaobei", "Xiaobei"), ("zf_xiaoni", "Xiaoni"),
    ("zf_xiaoxiao", "Xiaoxiao"), ("zf_xiaoyi", "Xiaoyi"),
    ("zm_yunjian", "Yunjian"), ("zm_yunxi", "Yunxi"),
    ("zm_yunxia", "Yunxia"), ("zm_yunyang", "Yunyang"),
    ("ef_dora", "Dora"), ("em_alex", "Alex"), ("em_santa", "Santa"),
    ("ff_siwis", "Siwis"),
    ("hf_alpha", "Alpha"), ("hf_beta", "Beta"),
    ("hm_omega", "Omega"), ("hm_psi", "Psi"),
    ("if_sara", "Sara"), ("im_nicola", "Nicola"),
    ("pf_dora", "Dora"), ("pm_alex", "Alex"), ("pm_santa", "Santa"),
]

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "static", "previews")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Use the voicebox backend's Python which has kokoro installed
    backend_python = os.path.join(
        os.path.dirname(__file__), "..", "..", "voicebox", "backend", "venv", "bin", "python"
    )
    if not os.path.exists(backend_python):
        print(f"Error: Voicebox backend venv not found at {backend_python}")
        print("Run 'just setup' in the voicebox repo first.")
        sys.exit(1)

    script = """
import sys
sys.path.insert(0, '/Users/harsh.rajmathur/Desktop/harsh-builds/voicebox')

from kokoro import KPipeline
import soundfile as sf
import numpy as np

voice_id = sys.argv[1]
name = sys.argv[2]
out_path = sys.argv[3]

# Determine language from voice ID prefix
lang_map = {
    'af': 'a', 'am': 'a',  # American
    'bf': 'b', 'bm': 'b',  # British
    'jf': 'j', 'jm': 'j',  # Japanese
    'zf': 'z', 'zm': 'z',  # Mandarin
    'ef': 'e', 'em': 'e',  # Spanish
    'ff': 'f',             # French
    'hf': 'h', 'hm': 'h',  # Hindi
    'if': 'i', 'im': 'i',  # Italian
    'pf': 'p', 'pm': 'p',  # Portuguese
}
lang_code = lang_map.get(voice_id[:2], 'a')

pipeline = KPipeline(lang_code=lang_code)
text = f"Hi, I'm {name}, and I'll be reading to you."

generator = pipeline(text, voice=voice_id, speed=1.0)
for i, (gs, ps, audio) in enumerate(generator):
    sf.write(out_path, audio, 24000)
    break  # Only first chunk

print(f"OK: {out_path}")
"""

    total = len(VOICES)
    for i, (voice_id, name) in enumerate(VOICES):
        out_path = os.path.join(OUTPUT_DIR, f"{voice_id}.wav")
        if os.path.exists(out_path):
            print(f"[{i+1}/{total}] Skip {voice_id} (exists)")
            continue

        print(f"[{i+1}/{total}] Generating {voice_id} ({name})...")
        result = subprocess.run(
            [backend_python, "-c", script, voice_id, name, out_path],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            print(f"  ERROR: {result.stderr[:200]}")
        else:
            size = os.path.getsize(out_path)
            print(f"  OK ({size / 1024:.0f} KB)")

    # Print summary
    files = [f for f in os.listdir(OUTPUT_DIR) if f.endswith('.wav')]
    total_size = sum(os.path.getsize(os.path.join(OUTPUT_DIR, f)) for f in files)
    print(f"\nDone: {len(files)} previews, {total_size / 1024 / 1024:.1f} MB total")


if __name__ == "__main__":
    main()
