#!/usr/bin/env python3
"""Repair names of the handoff's static SemiBold instance; outlines and metrics stay intact."""
from pathlib import Path
from fontTools.ttLib import TTFont

path = Path(__file__).resolve().parent.parent / 'public/fonts/IBMPlexSans-SemiBold.ttf'
font = TTFont(path, recalcTimestamp=False)
names = {1: 'IBM Plex Sans SemiBold', 2: 'Regular', 3: 'IBM Plex Sans SemiBold',
         4: 'IBM Plex Sans SemiBold', 6: 'IBMPlexSans-SemiBold',
         16: 'IBM Plex Sans', 17: 'SemiBold'}
for name_id, value in names.items():
    for platform, encoding, language in [(3, 1, 0x409), (1, 0, 0)]:
        font['name'].setName(value, name_id, platform, encoding, language)
font.save(path)
print(path)
