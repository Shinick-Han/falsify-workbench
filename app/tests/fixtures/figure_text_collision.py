"""Synthetic figure whose Form XObject resources collide with the page.

No private papers. The page has ExtGState GS0..GS2 and font T1_0. The figure
form reuses those names for different objects, adds GS3, and draws nested
cell forms plus white, black, and 45-degree labels. Writes PDF bytes to stdout.
"""
import io
import sys

import pikepdf
from pikepdf import Array, Dictionary, Name


CELL_W = 30
CELL_H = 18
CELLS = 140
GRID = 7


def extgstate(pdf, fill, stroke):
    return pdf.make_indirect(Dictionary({
        "/Type": Name("/ExtGState"),
        "/ca": fill,
        "/CA": stroke,
    }))


def font(pdf):
    return pdf.make_indirect(Dictionary({
        "/Type": Name("/Font"),
        "/Subtype": Name("/Type1"),
        "/BaseFont": Name("/Helvetica"),
        "/Encoding": Name("/WinAnsiEncoding"),
    }))


def cell_form(pdf, dark):
    gray = "0.12 0.12 0.12" if dark else "0.93 0.93 0.93"
    body = (
        "q\n"
        f"{gray} rg\n"
        f"0 0 {CELL_W} {CELL_H} re f\n"
        "Q\n"
        "% cell patch\n"
    ).encode("ascii")
    stream = pdf.make_stream(body)
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Form")
    stream["/FormType"] = 1
    stream["/BBox"] = Array([0, 0, CELL_W, CELL_H])
    return stream


def label_ops(name, x, y, text, white, face, rotate):
    if rotate:
        return (
            "q 0.7071 0.7071 -0.7071 0.7071 "
            f"{x:.1f} {y:.1f} cm BT /{face} 8 Tf 2 2 Td ({text}) Tj ET Q\n"
        )
    color = "1 1 1" if white else "0 0 0"
    return (
        f"q {color} rg BT /{face} 8 Tf 1 0 0 1 {x + 3:.1f} {y + 5:.1f} Tm ({text}) Tj ET Q\n"
        f"q 1 0 0 1 {x:.1f} {y:.1f} cm /{name} Do Q\n"
    )


def figure_content():
    labels = {
        (0, 0): ("96%", True, "T1_0", False),
        (0, 1): ("3%", True, "T1_1", False),
        (0, 2): ("23%", True, "T1_2", False),
        (1, 0): ("28%", True, "T1_3", False),
        (1, 1): ("1%", True, "T1_4", False),
        (1, 2): ("1%", False, "T1_0", False),
        (2, 0): ("44%", False, "T1_1", False),
        (2, 1): ("73%", False, "T1_2", False),
        (6, 0): ("AcuteUTI", False, "T1_0", True),
        (6, 1): ("PulmEmbol", False, "T1_1", True),
        (6, 2): ("HeartFail", False, "T1_2", True),
        (6, 3): ("SepsisCase", False, "T1_3", True),
        (6, 4): ("StrokeUnit", False, "T1_4", True),
    }
    parts = ["/GS3 gs\n/GS0 gs\n/GS1 gs\n/GS2 gs\n/Span /MC0 BDC\n"]
    for index in range(CELLS):
        row, col = divmod(index, GRID) if index < GRID * GRID else (20, index)
        x = 8 + (index % 12) * (CELL_W + 4)
        y = 8 + (index // 12) * (CELL_H + 6)
        spec = labels.get((row, col))
        if spec and index < GRID * GRID:
            text, white, face, rotate = spec
            parts.append(label_ops(f"Fm{index}", x, y, text, white, face, rotate))
        else:
            parts.append(f"q 1 0 0 1 {x:.1f} {y:.1f} cm /Fm{index} Do Q\n")
    parts.append("EMC\n")
    return "".join(parts).encode("ascii")


def build():
    pdf = pikepdf.Pdf.new()
    page_gs = [extgstate(pdf, 1, 1), extgstate(pdf, 0.55, 0.55), extgstate(pdf, 0.8, 0.8)]
    form_gs2 = extgstate(pdf, 0.25, 0.25)
    form_gs3 = extgstate(pdf, 1, 1)
    page_fonts = [font(pdf), font(pdf)]
    form_fonts = [font(pdf) for _ in range(5)]
    cells = [cell_form(pdf, dark=(index % 3 == 0)) for index in range(CELLS)]
    logo = cell_form(pdf, dark=False)
    image = pdf.make_stream(b"\xff\x00\x00\x00\xff\x00\x00\x00\xff")
    image["/Type"] = Name("/XObject")
    image["/Subtype"] = Name("/Image")
    image["/Width"] = 3
    image["/Height"] = 1
    image["/ColorSpace"] = Name("/DeviceRGB")
    image["/BitsPerComponent"] = 8
    figure = pdf.make_stream(figure_content())
    figure["/Type"] = Name("/XObject")
    figure["/Subtype"] = Name("/Form")
    figure["/FormType"] = 1
    figure["/BBox"] = Array([0, 0, 460, 340])
    figure["/Group"] = Dictionary({
        "/Type": Name("/Group"),
        "/S": Name("/Transparency"),
        "/I": True,
        "/CS": Name("/DeviceRGB"),
    })
    figure["/Resources"] = Dictionary({
        "/ExtGState": Dictionary({
            "/GS0": page_gs[1],
            "/GS1": page_gs[0],
            "/GS2": form_gs2,
            "/GS3": form_gs3,
        }),
        "/Font": Dictionary({f"/T1_{i}": form_fonts[i] for i in range(5)}),
        "/Properties": Dictionary({"/MC0": Dictionary({"/Type": Name("/OCG")})}),
        "/XObject": Dictionary({f"/Fm{i}": cells[i] for i in range(CELLS)}),
    })
    page = pdf.add_blank_page(page_size=(612, 792))
    story = (
        "BT /T1_0 11 Tf 72 740 Td (Body paragraph remains outside the figure.) Tj ET\n"
        "/GS0 gs /GS1 gs /GS2 gs\n"
        "q 1 0 0 1 72 360 cm /Fm2 Do Q\n"
        "q 20 0 0 8 72 80 cm /XO1 Do Q\n"
    ).encode("ascii")
    page["/Contents"] = pdf.make_stream(story)
    page["/Resources"] = Dictionary({
        "/ExtGState": Dictionary({
            "/GS0": page_gs[0],
            "/GS1": page_gs[1],
            "/GS2": page_gs[2],
        }),
        "/Font": Dictionary({"/T1_0": page_fonts[0], "/T1_1": page_fonts[1]}),
        "/XObject": Dictionary({"/Fm0": logo, "/Fm2": figure, "/XO1": image}),
    })
    out = io.BytesIO()
    pdf.save(out, compress_streams=True)
    return out.getvalue()


def main():
    sys.stdout.buffer.write(build())


if __name__ == "__main__":
    main()
