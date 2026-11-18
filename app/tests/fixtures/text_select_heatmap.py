"""Synthetic confusion-matrix page for text-selection tests.

No private papers. Writes PDF bytes to stdout.
"""
import sys

import pymupdf

PITCH = 36
GRID_X = 168
GRID_Y = 640


def cell_text(row, col):
    if row == 0 and col == 0:
        return "96% 1%"
    if row == 0 and col == 2 or row == 4 and col == 4:
        return "96%"
    if (row, col) in {(0, 1), (1, 0), (5, 1)}:
        return "1%"
    if (row, col) in {(2, 2), (3, 3), (6, 6)}:
        return "3%"
    if row == 2 and col == 3:
        return "44%"
    if row == 0 and col == 3:
        return "73%"
    return f"{row}{col}%"


def build():
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text(
        (72, 760),
        "Body paragraph remains outside the figures for selection checks.",
        fontsize=11,
        fontname="helv",
    )
    page.insert_text((46, 430), "Ground truth disease", fontsize=9, fontname="helv", rotate=90)
    labels = [
        "Acute UTI",
        "Pulm. embolism",
        "Heart failure",
        "Sepsis case",
        "Stroke unit",
        "Other cause",
        "Mixed label",
    ]
    for index, label in enumerate(labels):
        page.insert_text((78, GRID_Y - index * PITCH), label, fontsize=8, fontname="helv")
    for row in range(7):
        for col in range(7):
            page.insert_text(
                (GRID_X + col * PITCH, GRID_Y - row * PITCH),
                cell_text(row, col),
                fontsize=8,
                fontname="helv",
            )
    for index, tick in enumerate(("0", "0.2", "0.4", "0.6", "0.8")):
        page.insert_text((440, GRID_Y - index * PITCH), tick, fontsize=8, fontname="helv")
    page.insert_text((418, 500), "Pneumonia", fontsize=8, fontname="helv", rotate=90)
    for row, pair in enumerate((("9%", "8%"), ("7%", "4%"))):
        for col, text in enumerate(pair):
            page.insert_text((168 + col * PITCH, 220 - row * PITCH), text, fontsize=8, fontname="helv")
    return doc.tobytes()


def main():
    sys.stdout.buffer.write(build())


if __name__ == "__main__":
    main()
