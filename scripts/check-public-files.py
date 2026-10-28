"""Validate the explicit public source inventory; never stage or publish files."""
import argparse
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'public-files.json'


def ignore_text(paths):
    children = {}
    for name in paths:
        parts = name.split('/')
        for index, part in enumerate(parts):
            parent = '/'.join(parts[:index])
            child = '/'.join(parts[:index + 1])
            children.setdefault(parent, set()).add((child, index < len(parts) - 1))
    lines = ['# Generated from public-files.json by scripts/check-public-files.py --write-ignore.',
             '# Unlisted local files are retained but excluded from Git.']
    for parent in sorted(children, key=lambda p: (p.count('/') + bool(p), p)):
        lines.append('/' + (parent + '/' if parent else '') + '*')
        for child, directory in sorted(children[parent]):
            lines.append('!/' + child + ('/' if directory else ''))
    return '\n'.join(lines) + '\n'


def git(*arguments):
    return subprocess.check_output(
        ['git', '-c', f'safe.directory={ROOT.as_posix()}', *arguments], cwd=ROOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true', help='Require the entire Git index to match the inventory')
    parser.add_argument('--write-ignore', action='store_true', help='Regenerate the default-deny .gitignore')
    args = parser.parse_args()
    data = json.loads(MANIFEST.read_text(encoding='utf-8'))
    paths = data['files']
    if not paths or paths != sorted(set(paths)):
        raise ValueError('files must be a nonempty sorted list without duplicates')
    for name in paths:
        relative = PurePosixPath(name)
        if '\\' in name or relative.is_absolute() or '..' in relative.parts or relative.as_posix() != name:
            raise ValueError(f'Invalid relative path: {name}')
        if any(part in {'.git', '.local', '.tools', 'node_modules', '__pycache__', 'artifacts', 'evidence', 'dist'} for part in relative.parts):
            raise ValueError(f'Local/generated directory in inventory: {name}')
        if relative.name.startswith('.env') and relative.name != '.env.example':
            raise ValueError(f'Only .env.example is allowed: {name}')
        source = ROOT / name
        if not source.is_file() or not source.resolve().is_relative_to(ROOT):
            raise ValueError(f'Missing or external file: {name}')
        if source.is_symlink():
            raise ValueError(f'Symlink is not permitted: {name}')
        # Check ancestors explicitly, including Windows directory links/junctions.
        for ancestor in source.parents:
            if ancestor == ROOT:
                break
            if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
                raise ValueError(f'Linked parent is not permitted: {name}')
    expected_ignore = ignore_text(paths)
    ignore = ROOT / '.gitignore'
    if args.write_ignore:
        ignore.write_text(expected_ignore, encoding='utf-8', newline='\n')
    elif ignore.read_text(encoding='utf-8') != expected_ignore:
        raise ValueError('Run python scripts/check-public-files.py --write-ignore after changing the inventory')
    if args.staged:
        staged = sorted(name.decode('utf-8') for name in git('ls-files', '-z').split(b'\0') if name)
        if staged != paths:
            raise ValueError(f'Index differs: missing={sorted(set(paths)-set(staged))}; extra={sorted(set(staged)-set(paths))}')
        unstaged = git('diff', '--name-only', '-z')
        if unstaged:
            raise ValueError('Tracked working files differ from the reviewed index')
    print(f'Public inventory verified: {len(paths)} files' + ('; index matches' if args.staged else ''))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'Public inventory check failed: {error}', file=sys.stderr)
        sys.exit(1)
