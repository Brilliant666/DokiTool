"""Offline contract / process checks. Does not start services or contact media platforms."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--php', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--http-evidence', help='Optional separate HTTP receipt; this command never starts services')
args = parser.parse_args()
backend = Path(__file__).resolve().parents[1]
php = str(Path(args.php).resolve())


def run(arguments, env=None):
    return subprocess.run([php, *arguments], capture_output=True, text=True,
                          encoding='utf-8', timeout=20, env=env)


result = run([str(backend / 'tests/contract.php')])
contract = json.loads(result.stdout)
parser_checks = []
for suite in ['douyin', 'pipigx', 'bilibili', 'zuiyou', 'weibo']:
    checked = run([str(backend / 'tests/parser-contract.php'), suite])
    payload = json.loads(checked.stdout)
    parser_checks.append(dict(payload, successful=checked.returncode == 0))
for suite in ['weibo', 'toutiao', 'pipixia']:
    checked = run([str(backend / f'tests/{suite}-contract.php')])
    payload = json.loads(checked.stdout)
    parser_checks.append(dict(payload, successful=checked.returncode == 0
                              and payload.get('total', 0) > 0
                              and payload.get('passed') == payload.get('total')))
lint = []
# Retained optional upstream files are ignored, not part of this product's API.
inventory = json.loads((backend.parent / 'public-files.json').read_text(encoding='utf-8'))
php_sources = {backend.parent / path for path in inventory['files'] if path.startswith('backend/') and path.endswith('.php')}
php_sources.add(backend / 'tests/parser-contract.php')
for source in sorted(php_sources):
    checked = run(['-l', str(source)])
    lint.append({'path': source.relative_to(backend).as_posix(), 'passed': checked.returncode == 0})

cases = [
    ('real Bilibili exit() business failure', '/api/bilibili', 'GET', {'url': 'https://www.bilibili.com/not-a-video'}, '127.0.0.1', 'snap.dokitool.com', '', 200, -1, False),
    ('real Pipigx HTTP400 business failure', '/parse/pipigx', 'GET', {'url': 'https://h5.pipigx.com/fixture'}, '127.0.0.1', 'snap.dokitool.com', 'internal', 400, 400, False),
    ('internal rejects remote callers', '/parse/pipigx', 'GET', {'url': 'https://h5.pipigx.com/fixture'}, '8.8.8.8', 'snap.dokitool.com', 'internal', 403, 403, False),
    ('internal rejects wrong Host', '/parse/douyin', 'GET', {}, '127.0.0.1', 'attacker.test', 'internal', 403, 403, False),
    ('public media proxy closed', '/api/svproxyurl.php', 'GET', {}, '127.0.0.1', 'snap.dokitool.com', '', 404, 404, False),
    ('internal cannot call aggregate recursively', '/api/short_videos', 'GET', {}, '127.0.0.1', 'snap.dokitool.com', 'internal', 404, 404, False),
    ('POST is rejected', '/api/douyin', 'POST', {}, '127.0.0.1', 'snap.dokitool.com', '', 405, 405, False),
    ('curl missing returns configuration failure', '/api/douyin', 'GET', {'url': 'https://v.douyin.com/fixture'}, '127.0.0.1', 'snap.dokitool.com', '', 503, 503, True),
]
process_checks = []
for name, path, method, query, remote, host, kind, status, code, no_ini in cases:
    command = (['-n'] if no_ini else []) + [str(backend / 'tests/cli-request.php'), path, method, json.dumps(query), remote, host, kind]
    case = run(command)
    try:
        body = json.loads(case.stdout)
        info = json.loads(case.stderr)
        passed = case.returncode == 0 and info['httpStatus'] == status and body['code'] == code
    except (ValueError, KeyError):
        passed = False
    process_checks.append({'name': name, 'passed': passed, 'expected_http_status': status, 'expected_business_code': code})

env = dict(os.environ, SNAP_INTERNAL_ORIGIN='http://127.0.0.1:19187')
case = run([str(backend / 'tests/cli-request.php'), '/api/short_videos', 'GET', json.dumps({'url': 'https://v.douyin.com/fixture'})], env)
try:
    passed = json.loads(case.stdout)['code'] == 502 and json.loads(case.stderr)['httpStatus'] == 502
except (ValueError, KeyError):
    passed = False
process_checks.append({'name': 'aggregate loopback connection failure', 'passed': passed, 'expected_http_status': 502, 'expected_business_code': 502})

http_integration = {
    'status': 'not_run_by_this_command',
    'reason': 'This runner performs offline contract, lint and CLI checks only. HTTP tests require a separate receipt.',
}
if args.http_evidence:
    receipt_path = Path(args.http_evidence)
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    valid = (receipt.get('suite') == 'backend-local-http'
             and receipt.get('exit_code') == 0
             and receipt.get('passed', 0) > 0
             and receipt.get('passed') == receipt.get('total')
             and len(receipt.get('checks', [])) == receipt.get('total')
             and all(item.get('passed') for item in receipt['checks']))
    tested_files = receipt.get('tested_files', {})
    if not tested_files:
        raise ValueError('HTTP receipt must identify the tested source hashes')
    for relative, expected_hash in tested_files.items():
        source = (backend / relative).resolve()
        if not source.is_relative_to(backend) or hashlib.sha256(source.read_bytes()).hexdigest() != expected_hash:
            raise ValueError('HTTP receipt does not match current backend sources')
    if not valid:
        raise ValueError('HTTP receipt does not report a fully passing suite')
    http_integration = {
        'status': 'passed', 'passed': receipt['passed'], 'total': receipt['total'],
        'evidence': str(receipt_path),
        'sha256': hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
        'scope': receipt['scope'], 'recorded_at': receipt['recorded_at'],
    }

report = {
    'recorded_at': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec='seconds'),
    'php_version': run(['-r', 'echo PHP_VERSION;']).stdout,
    'contract': contract,
    'parser_contracts': parser_checks,
    'lint': lint,
    'process_checks': process_checks,
    'http_integration': http_integration,
    'limitations': [
        'No real media platform, user Cookie/account or paid endpoint was called.',
        'CLI checks are not HTTP/FPM/Caddy integration acceptance.',
        'Aggregate transport success and redirect/failure responses use an injected test transport in contract.php.',
        'No VPS, DNS or production access was performed.',
    ],
}
report['passed'] = result.returncode == 0 and all(x['passed'] for x in lint + process_checks) and all(x['successful'] for x in parser_checks)
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'passed': report['passed'], 'contract': f"{contract['passed']}/{contract['total']}", 'lint_files': len(lint), 'process_checks': f"{sum(x['passed'] for x in process_checks)}/{len(process_checks)}", 'http_integration': http_integration['status'], 'output': str(output)}, ensure_ascii=False))
raise SystemExit(0 if report['passed'] else 1)
