"""Extract the device schedule and two inline PNG assets from the latest DCS DOCX.

Run with the bundled Python runtime and an explicit source DOCX path. This script
keeps the DOCX table as the source of truth; it does not infer data from older CSVs.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from docx import Document


# Darker UI hues follow the terminal-specific pastel row colors in the DOCX.
# Hotspots are percentages centered over its red A-H labels in inline shape 1.
GROUPS = [
    {"id": "A", "color": "#397CAC", "hotspot": {"x": 91.1, "y": 42.0}},
    {"id": "B", "color": "#C96A37", "hotspot": {"x": 65.9, "y": 87.3}},
    {"id": "C", "color": "#6A9844", "hotspot": {"x": 65.9, "y": 25.6}},
    {"id": "D", "color": "#8A63A9", "hotspot": {"x": 27.8, "y": 80.7}},
    {"id": "E", "color": "#B18925", "hotspot": {"x": 27.8, "y": 55.5}},
    {"id": "F", "color": "#218C90", "hotspot": {"x": 9.6, "y": 54.9}},
    {"id": "G", "color": "#C15281", "hotspot": {"x": 1.7, "y": 61.2}},
    {"id": "H", "color": "#806E58", "hotspot": {"x": 1.7, "y": 32.5}},
]

EQUIPMENT = [
    {"id": "control-box", "name": "Control Box", "color": "#397CAC", "hotspot": {"x": 84, "y": 18}},
    {"id": "solenoid-box", "name": "Solenoid Box", "color": "#218C90", "hotspot": {"x": 82, "y": 62}},
    {"id": "transducer-panel", "name": "Transducer Panel", "color": "#8A63A9", "hotspot": {"x": 19, "y": 71}},
]


def extract(docx_path: Path, output_root: Path) -> dict:
    document = Document(docx_path)
    if len(document.tables) != 1:
        raise ValueError(f"Expected one schedule table, found {len(document.tables)}")

    table = document.tables[0]
    header = [cell.text.strip() for cell in table.rows[0].cells[:4]]
    if header != ["Terminal", "Cable Type", "Device Name", "Cable Number"]:
        raise ValueError(f"Unexpected schedule columns: {header}")

    devices_by_id = {}
    for row in table.rows[2:]:  # Second row is the cable-length subheader.
        terminal, cable_type, name, cable_number = (
            cell.text.strip() for cell in row.cells[:4]
        )
        if not name:
            continue
        if terminal not in set("ABCDEFGH") or not cable_number.isdecimal():
            raise ValueError(f"Invalid schedule row: {terminal}, {name}, {cable_number}")
        device = devices_by_id.setdefault(
            name, {"id": name, "name": name, "terminal": terminal, "cables": []}
        )
        if device["terminal"] != terminal:
            raise ValueError(f"Device {name} belongs to multiple terminals")
        cable = {"type": cable_type, "number": int(cable_number)}
        if cable not in device["cables"]:
            device["cables"].append(cable)

    data = {
        "project": {"title": "450k skid x7 - DCS", "revision": 3},
        "equipment": EQUIPMENT,
        "groups": GROUPS,
        "devices": list(devices_by_id.values()),
    }
    if len(data["devices"]) != 28:
        raise ValueError(f"Expected 28 devices, found {len(data['devices'])}")

    data_path = output_root / "src" / "data" / "schedule.json"
    data_path.parent.mkdir(parents=True, exist_ok=True)
    data_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    assets_path = output_root / "public" / "assets"
    assets_path.mkdir(parents=True, exist_ok=True)
    for shape_index, filename in [(0, "jeevy-logo.png"), (1, "conduit-layout.png")]:
        shape = document.inline_shapes[shape_index]
        image_id = shape._inline.graphic.graphicData.pic.blipFill.blip.embed
        part = document.part.related_parts[image_id]
        if part.content_type != "image/png":
            raise ValueError(f"Inline shape {shape_index} is {part.content_type}")
        (assets_path / filename).write_bytes(part.blob)
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    result = extract(args.docx, args.output_root)
    print(f"Extracted {len(result['devices'])} devices into {args.output_root}")
