"""Copy installed production-dependency license text into the static distribution."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
front = root / 'frontend'
lock = json.loads((front / 'package-lock.json').read_text(encoding='utf-8'))
parts = ['DokiTool bundled frontend dependency notices\nUpstream application licenses are frontend/LICENSE and backend/LICENSE.\n']
for rel, data in sorted(lock['packages'].items()):
    if not rel or data.get('dev') or not (front / rel).is_dir():
        continue
    pkg = front / rel
    name = rel.split('node_modules/')[-1]
    licenses = [p for p in pkg.iterdir() if p.is_file() and p.name.lower().startswith(('license', 'copying'))]
    parts.append(f'\n===== {name} {data.get("version", "")} =====\n')
    if name == '@vue/devtools-api' and not licenses:
        parts.append('Source: https://raw.githubusercontent.com/vuejs/vue-devtools/v6.6.4/LICENSE\n')
        licenses = [front / 'public/licenses/vue-devtools-api-MIT.txt']
    if name == 'isarray' and not licenses:
        parts.append((pkg / 'README.md').read_text(encoding='utf-8').split('## License', 1)[1].replace('&lt;', '<').replace('&gt;', '>'))
        continue
    if not licenses:
        raise SystemExit(f'Missing license file for production dependency {name}; inspect manually')
    for p in sorted(licenses):
        parts.append(p.read_text(encoding='utf-8', errors='replace'))
text = '\n'.join(parts)
for folder in [front / 'public/licenses', front / 'dist/licenses']:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'third-party-notices.txt').write_text(text, encoding='utf-8')
(front / 'dist/licenses/vue-devtools-api-MIT.txt').write_bytes((front / 'public/licenses/vue-devtools-api-MIT.txt').read_bytes())
print(f'Wrote {len(text)} characters of production dependency license notices')
