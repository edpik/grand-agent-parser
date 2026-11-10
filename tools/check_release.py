"""Fail before packaging when the tag and public version metadata disagree."""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assert re.fullmatch(r'v\d+\.\d+\.\d+', sys.argv[1]), 'Expected vX.Y.Z tag'
version = sys.argv[1][1:]
for name in ['web/package.json', 'web/package-lock.json', 'desktop/package.json', 'desktop/package-lock.json']:
    value = json.loads((root / name).read_text(encoding='utf-8'))
    assert value['version'] == version, f'{name}: version mismatch'
    if 'packages' in value:
        assert value['packages']['']['version'] == version, f'{name}: root package version mismatch'
for name, expression in [('pyproject.toml', r'^version = "([^"]+)"'),
                         ('grand_parser/__init__.py', r'^__version__ = "([^"]+)"')]:
    match = re.search(expression, (root / name).read_text(encoding='utf-8'), re.M)
    assert match and match[1] == version, f'{name}: version mismatch'
print(f'Release version metadata is consistent: {version}')
