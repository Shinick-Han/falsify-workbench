"""One-time optional model runtime setup. No PDF or user document is read."""
import argparse
import json
import os
import subprocess
import sys
import venv
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, default=Path.home()/'.falsify'/'paper-analysis')
    args = parser.parse_args()
    target = args.runtime.expanduser().resolve()
    if (target/'ARCHIVED.json').exists(): parser.error('Restore the archived runtime before setup.')
    venv.EnvBuilder(with_pip=True, system_site_packages=True).create(target)
    python = target/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(Path(__file__).with_name('requirements-paper-analysis.txt'))],
                   check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    # Multiple OpenCV distributions share cv2. Install contrib last into this venv,
    # including when an inherited distribution already satisfies pip metadata.
    subprocess.run([str(python), '-m', 'pip', 'install', '--no-deps', '--force-reinstall', 'opencv-contrib-python==5.0.0.93'],
                   check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    subprocess.run([str(python), '-c', 'import rapidocr,img2table,transformers,torch,cv2; assert hasattr(cv2,"ximgproc"); print("OCR and chart runtime ready")'],
                   check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    warm = ('from huggingface_hub import snapshot_download; '
            'snapshot_download("google/deplot",revision="6e76d62430da16986be3426bae32301fb9115397",'
            'allow_patterns=["*.json","*.model","model.safetensors"])')
    subprocess.run([str(python), '-c', warm], check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    config = Path.home()/'.falsify'/'paper-analysis-runtime.json'
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({'schema':'falsify.paper-analysis-runtime.v1','python':str(python)}), encoding='utf-8')
    print('Runtime configured. Models are loaded only when an analysis is requested.')


if __name__ == '__main__': main()
