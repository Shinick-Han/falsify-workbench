"""Frontmatter and fenced-command checks for the corpus-author skill."""
from __future__ import annotations

import argparse
import importlib.util
import re
import shlex
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / ".agents" / "skills"
AUTHOR = SKILLS / "falsify-corpus-author" / "SKILL.md"
FENCE = re.compile(r"```([^\n`]*)\n(.*?)```", re.DOTALL)
PREFIXES = ("python tools/corpus/", "python app/local/falsify_cli.py")
SHELLS = {"", "bash", "sh", "shell", "console"}
_PARSERS: dict[str, argparse.ArgumentParser] = {}


def _frontmatter_keys(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8")
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", raw, re.DOTALL)
    if not match:
        raise AssertionError(f"missing frontmatter: {path}")
    keys = []
    for line in match.group(1).splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            raise AssertionError(f"frontmatter line: {line}")
        keys.append(line.split(":", 1)[0].strip())
    return keys


def _other_skill_keys() -> list[list[str]]:
    found = []
    for path in sorted(SKILLS.glob("*/SKILL.md")):
        if path.resolve() == AUTHOR.resolve():
            continue
        found.append(_frontmatter_keys(path))
    return found


def _join_shell(body: str) -> list[str]:
    lines = []
    pending = ""
    for raw in body.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            pending += stripped[:-1].rstrip() + " "
            continue
        lines.append((pending + stripped).strip())
        pending = ""
    if pending:
        lines.append(pending.strip())
    return lines


def _fenced_commands(text: str) -> list[list[str]]:
    commands = []
    for match in FENCE.finditer(text):
        if match.group(1).strip().lower() not in SHELLS:
            continue
        for line in _join_shell(match.group(2)):
            if line.startswith(PREFIXES):
                commands.append(shlex.split(line, posix=True))
    return commands


def _load_parser(script: Path) -> argparse.ArgumentParser:
    key = str(script.resolve())
    cached = _PARSERS.get(key)
    if cached is not None:
        return cached
    folder = str(script.parent)
    if folder not in sys.path:
        sys.path.insert(0, folder)
    spec = importlib.util.spec_from_file_location(f"corpus_author_{script.stem}", script)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    factory = getattr(module, "_parser", None)
    if script.name == "falsify_cli.py":
        factory = module._build_parser
    if not callable(factory):
        raise AssertionError(f"no parser in {script.name}")
    parser = factory()
    _PARSERS[key] = parser
    return parser


def _subparsers(parser: argparse.ArgumentParser):
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action
    return None


def _walk(parser: argparse.ArgumentParser, argv: list[str]) -> None:
    current = parser
    for token in argv:
        action = _subparsers(current)
        if action is None or token.startswith("-"):
            return
        if token not in action.choices:
            raise AssertionError(f"rejected subcommand {token}")
        current = action.choices[token]


def _assert_vendor(script: Path, argv: list[str]) -> None:
    if not argv or argv[0].startswith("-"):
        raise AssertionError("vendor subcommand missing")
    completed = subprocess.run(
        [sys.executable, str(script), argv[0], "--help"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout)[-500:]
        raise AssertionError(detail)


def _assert_subcommand(script: Path, argv: list[str]) -> None:
    if script.name == "vendor.py":
        _assert_vendor(script, argv)
        return
    _walk(_load_parser(script), argv)


class CorpusAuthorSkillTests(unittest.TestCase):
    def test_frontmatter_keys_match_other_skills(self):
        others = _other_skill_keys()
        self.assertGreaterEqual(len(others), 1)
        expected = others[0]
        for keys in others[1:]:
            self.assertEqual(keys, expected)
        self.assertEqual(_frontmatter_keys(AUTHOR), expected)

    def test_fenced_corpus_commands_are_accepted_subcommands(self):
        commands = _fenced_commands(AUTHOR.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(commands), 1)
        prefixes = []
        for argv in commands:
            self.assertGreaterEqual(len(argv), 2, argv)
            self.assertEqual(argv[0], "python")
            script = ROOT / Path(argv[1])
            self.assertTrue(script.is_file(), argv[1])
            _assert_subcommand(script, argv[2:])
            prefixes.append(argv[1])
        self.assertTrue(any(item.startswith("tools/corpus/") for item in prefixes))
        self.assertTrue(any(item == "app/local/falsify_cli.py" for item in prefixes))


if __name__ == "__main__":
    unittest.main()
