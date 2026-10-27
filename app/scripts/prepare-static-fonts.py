import argparse, hashlib, json
from pathlib import Path
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# Google Fonts commit e7db6ca603fd4862010383ff17ffd6cc4ffac1c0.
SOURCES = {
    'notoserif-NotoSerif[wdth,wght].ttf': '4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713',
    'notoserif-NotoSerif-Italic[wdth,wght].ttf': 'e87acbc6c0efd0d9a20d6a8cbbda2b266c14be3a3a6f5af8ec9d7b2460570ad1',
    'notosans-NotoSans[wdth,wght].ttf': 'bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d',
    'notosans-NotoSans-Italic[wdth,wght].ttf': '58e6e0ebd1931b29a365aa2d3e2ee9a9e831a3af7cf3ad1462d4e72154f0b291',
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def name(font, key):
    value = font['name'].getDebugName(key)
    return value

def main():
    parser = argparse.ArgumentParser(description='Instantiate verified pinned Noto variable fonts offline.')
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if fontTools.__version__ != '4.66.0':
        raise SystemExit('Requires fonttools 4.66.0 for reproducible output')
    # Validate every source before writing anything.
    for filename, expected in SOURCES.items():
        if sha((args.source / filename).read_bytes()) != expected:
            raise SystemExit(f'Source hash mismatch: {filename}')
    source_dir = args.source.resolve()
    output_dir = args.output.resolve()
    if source_dir == output_dir or source_dir in output_dir.parents or output_dir in source_dir.parents:
        raise SystemExit('Source and output directories must be separate')
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for filename, expected in SOURCES.items():
        source = TTFont(args.source / filename, recalcTimestamp=False)
        axes = {a.axisTag: a.defaultValue for a in source['fvar'].axes}
        source_cmap = set(source.getBestCmap())
        for weight in (400, 700):
            limits = dict(axes, wght=weight)
            font = instantiateVariableFont(source, limits, updateFontNames=True, static=True)
            font.recalcTimestamp = False
            italic = 'Italic' in filename
            family = 'NotoSerif' if 'notoserif' in filename else 'NotoSans'
            style = ('Bold' if weight == 700 else 'Regular') + ('Italic' if italic else '')
            if italic and weight == 400: style = 'Italic'
            out = args.output / f'{family}-{style}.ttf'
            font.save(out, reorderTables=True)
            check = TTFont(out, recalcTimestamp=False)
            cmap = set(check.getBestCmap())
            if ('fvar' in check or check['OS/2'].usWeightClass != weight
                or bool(check['OS/2'].fsSelection & 1) != italic or cmap != source_cmap):
                raise RuntimeError(f'Validation failed: {out.name}')
            records.append({'file':out.name, 'sha256':sha(out.read_bytes()), 'bytes':out.stat().st_size,
                'source':filename, 'sourceSha256':expected, 'axes':limits,
                'family':name(check, 1), 'subfamily':name(check, 2), 'typographicFamily':name(check, 16),
                'typographicSubfamily':name(check, 17), 'postscript':name(check, 6),
                'weight':check['OS/2'].usWeightClass, 'italic':bool(check['OS/2'].fsSelection & 1),
                'cmapScalars':len(cmap), 'sourceCmapEqual':cmap == source_cmap,
                'copyright':name(check, 0), 'license':name(check, 13)})
            check.close(); font.close()
        source.close()
    (args.output / 'manifest.json').write_text(json.dumps({'sourceCommit':'e7db6ca603fd4862010383ff17ffd6cc4ffac1c0', 'fonttools':fontTools.__version__, 'faces':records}, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')

if __name__ == '__main__': main()
