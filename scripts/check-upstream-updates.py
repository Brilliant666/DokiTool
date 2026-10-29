#!/usr/bin/env python3
"""Observe public upstream metadata and notify through one repository Issue.

Uses only the Python standard library. No upstream source is downloaded or run.
The notification and its observed state share one atomic Issue/comment POST.
"""
import argparse
import base64
import datetime as dt
import html
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'Brilliant666/DokiTool'
OWNER = 'Brilliant666'
UPSTREAMS = ('jiuhunwl/short_videos', 'jiuhunwl/shortvideo-html')
BOT = 'github-actions[bot]'
TITLE = 'DokiTool 上游更新检查'
MARKER = '<!-- dokitool-upstream-watch-state:v1:'
STATE_RE = re.compile(re.escape(MARKER) + r'([A-Za-z0-9+/=]+) -->')
SHA_RE = re.compile(r'[0-9a-f]{40}\Z')
MAX_BODY = 65000
SHANGHAI = dt.timezone(dt.timedelta(hours=8))


class WatchError(RuntimeError):
    """An incomplete or unsafe check must not advance notification state."""


def safe_text(value, limit=180):
    """Keep upstream strings from creating mentions, Markdown or HTML."""
    value = ''.join(c if c.isprintable() else ' ' for c in str(value))[:limit]
    value = value.replace('@', '＠')
    value = re.sub(r'([\\`*_{}\[\]()#+.!|~\-])', r'\\\1', value)
    return html.escape(value, quote=False)


def checked_sha(value):
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise WatchError('Invalid commit or tag object SHA')
    return value


def checked_text(value, description, maximum=2048):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise WatchError('Invalid ' + description)
    return value


def normalize_snapshot(snapshot):
    """Only fields relevant to version/update detection enter the fingerprint."""
    if not isinstance(snapshot, dict):
        raise WatchError('Invalid repository snapshot')
    branch = checked_text(snapshot.get('default_branch'), 'default branch', 256)
    head = checked_sha(snapshot.get('head_sha'))
    if not isinstance(snapshot.get('releases'), list) or not isinstance(snapshot.get('tags'), list):
        raise WatchError('Incomplete releases or tags snapshot')
    releases, tags = [], []
    release_ids, tag_names = set(), set()
    for release in snapshot['releases']:
        if not isinstance(release, dict):
            raise WatchError('Invalid release metadata')
        ident = release.get('id')
        if type(ident) is not int or ident <= 0 or ident in release_ids:
            raise WatchError('Invalid or duplicate release ID')
        release_ids.add(ident)
        dates = {}
        for field in ('published_at', 'updated_at'):
            date = release.get(field)
            if field == 'updated_at' and date is None:
                raise WatchError('Release update timestamp is missing')
            if date is not None:
                try:
                    parsed = dt.datetime.fromisoformat(date.replace('Z', '+00:00'))
                    if parsed.tzinfo is None:
                        raise ValueError('Timestamp lacks a timezone')
                except (AttributeError, TypeError, ValueError) as error:
                    raise WatchError('Invalid release timestamp') from error
            dates[field] = date
        if type(release.get('prerelease')) is not bool:
            raise WatchError('Missing release prerelease status')
        releases.append({'id': ident, 'tag_name': checked_text(release.get('tag_name'), 'release tag'),
                         **dates, 'prerelease': release['prerelease']})
    for tag in snapshot['tags']:
        if not isinstance(tag, dict):
            raise WatchError('Invalid tag metadata')
        name = checked_text(tag.get('ref'), 'tag ref')
        if not name.startswith('refs/tags/') or name in tag_names:
            raise WatchError('Invalid or duplicate tag ref')
        tag_names.add(name)
        if tag.get('type') not in ('tag', 'commit'):
            raise WatchError('Unexpected tag object type')
        tags.append({'ref': name, 'object_sha': checked_sha(tag.get('object_sha')), 'type': tag['type']})
    return {'default_branch': branch, 'head_sha': head,
            'releases': sorted(releases, key=lambda x: x['id']),
            'tags': sorted(tags, key=lambda x: x['ref'])}


def normalize_state(state):
    if not isinstance(state, dict) or state.get('schema') != 1:
        raise WatchError('Unsupported observation state schema')
    repos = state.get('repositories')
    if not isinstance(repos, dict) or set(repos) != set(UPSTREAMS):
        raise WatchError('Observation state does not cover exactly the two upstreams')
    observed_at = checked_text(state.get('observed_at'), 'observation timestamp')
    try:
        parsed = dt.datetime.fromisoformat(observed_at.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('Timestamp lacks a timezone')
    except ValueError as error:
        raise WatchError('Invalid observation timestamp') from error
    return {'schema': 1, 'observed_at': observed_at,
            'repositories': {name: normalize_snapshot(repos[name]) for name in UPSTREAMS}}


def state_marker(state):
    raw = json.dumps(normalize_state(state), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return MARKER + base64.b64encode(raw).decode('ascii') + ' -->'


def extract_state(body):
    if not isinstance(body, str) or MARKER not in body:
        raise WatchError('Observation state marker is missing')
    matches = STATE_RE.findall(body)
    if len(matches) != 1 or body.count(MARKER) != 1:
        raise WatchError('Observation state marker is malformed or duplicated')
    try:
        return normalize_state(json.loads(base64.b64decode(matches[0], validate=True).decode('utf-8')))
    except (ValueError, UnicodeError) as error:
        raise WatchError('Observation state could not be decoded') from error


def validate_api_url(path):
    url = 'https://api.github.com' + path if path.startswith('/') else path
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'api.github.com' or parsed.fragment:
        raise WatchError('GitHub API URL must stay on api.github.com')
    roots = tuple('/repos/' + name for name in (TARGET, *UPSTREAMS))
    if not any(parsed.path == root or parsed.path.startswith(root + '/') for root in roots):
        raise WatchError('GitHub API URL is outside the approved repositories')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


class GitHub:
    def __init__(self, token, opener=None):
        if not token:
            raise WatchError('GITHUB_TOKEN is required')
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method, path, data=None):
        url = validate_api_url(path)
        endpoint = urllib.parse.urlsplit(url).path
        issue_root = '/repos/' + TARGET + '/issues'
        allowed_post = endpoint == issue_root or re.fullmatch(re.escape(issue_root) + r'/[1-9][0-9]*/comments', endpoint)
        allowed_patch = re.fullmatch(re.escape(issue_root) + r'/[1-9][0-9]*', endpoint) and data == {'state': 'open'}
        if method != 'GET' and not (method == 'POST' and allowed_post) and not (method == 'PATCH' and allowed_patch):
            raise WatchError('Only target repository Issue notifications may be written')
        headers = {'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + self.token,
                   'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DokiTool-Upstream-Watch'}
        payload = None
        if data is not None:
            payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        try:
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            with self.opener.open(request, timeout=25) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise WatchError('GitHub API response exceeded the safe size limit')
                return json.loads(raw.decode('utf-8')), response.headers
        except urllib.error.HTTPError as error:
            raise WatchError(f'GitHub API {method} failed with HTTP {error.code}; keep saved state and re-read it before retrying') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeError):
            raise WatchError(f'GitHub API {method} was not confirmed or returned invalid JSON; re-read saved notifications before retrying') from None

    def get(self, path):
        value = self.request('GET', path)[0]
        if not isinstance(value, dict):
            raise WatchError('Expected a GitHub API object')
        return value

    def items(self, path):
        result, seen = [], set()
        while path:
            url = validate_api_url(path)
            if url in seen or len(seen) >= 1000:
                raise WatchError('GitHub API pagination is incomplete or cyclic')
            seen.add(url)
            page, headers = self.request('GET', url)
            if not isinstance(page, list):
                raise WatchError('Expected a paginated GitHub API list')
            result.extend(page)
            links = re.findall(r'<([^>]+)>\s*;\s*rel="next"', headers.get('Link', ''))
            if len(links) > 1:
                raise WatchError('Ambiguous GitHub API pagination')
            path = links[0] if links else None
        return result


def load_sources(root=ROOT):
    raw = json.loads((root / 'UPSTREAM.json').read_text(encoding='utf-8'))
    sources = {}
    for item in raw['repositories']:
        url = item.get('url')
        name = next((repo for repo in UPSTREAMS if url == 'https://github.com/' + repo), None)
        if name is None or name in sources:
            raise WatchError('Unexpected or duplicate configured upstream')
        checked_sha(item.get('commit'))
        if not isinstance(item.get('imported_paths'), list) or not all(isinstance(x, str) for x in item['imported_paths']):
            raise WatchError('Imported upstream paths are missing')
        sources[name] = item
    if set(sources) != set(UPSTREAMS):
        raise WatchError('Both configured upstreams are required')
    return sources


def collect_snapshot(api, repo):
    prefix = '/repos/' + repo
    metadata = api.get(prefix)
    branch = checked_text(metadata.get('default_branch'), 'upstream default branch', 256)
    ref = api.get(prefix + '/git/ref/heads/' + urllib.parse.quote(branch, safe=''))
    releases = [r for r in api.items(prefix + '/releases?per_page=100') if r.get('draft') is not True]
    tags = api.items(prefix + '/git/matching-refs/tags/?per_page=100')
    snapshot = {'default_branch': branch, 'head_sha': ref.get('object', {}).get('sha'),
                'releases': releases,
                'tags': [{'ref': t.get('ref'), 'object_sha': t.get('object', {}).get('sha'),
                          'type': t.get('object', {}).get('type')} for t in tags]}
    return normalize_snapshot(snapshot)


def is_bot(item):
    author = item.get('user', {})
    return author.get('login') == BOT and author.get('type') == 'Bot'


def find_issue(api):
    query = urllib.parse.urlencode({'state': 'all', 'creator': BOT, 'per_page': 100})
    matches = [issue for issue in api.items('/repos/' + TARGET + '/issues?' + query)
               if 'pull_request' not in issue and issue.get('title') == TITLE and is_bot(issue)]
    if len(matches) > 1:
        raise WatchError('More than one managed upstream tracking Issue exists')
    if not matches:
        return None, None
    issue = matches[0]
    if type(issue.get('number')) is not int or issue['number'] <= 0:
        raise WatchError('Invalid tracking Issue number')
    state = extract_state(issue['body'])
    comments = api.items(f'/repos/{TARGET}/issues/{issue["number"]}/comments?per_page=100')
    for comment in sorted(comments, key=lambda c: c['id']):
        if is_bot(comment) and MARKER in (comment.get('body') or ''):
            state = extract_state(comment['body'])
    return issue, state


def describe_changes(old, new):
    lines = []
    if old['default_branch'] != new['default_branch']:
        lines.append('默认分支：' + safe_text(old['default_branch']) + ' → ' + safe_text(new['default_branch']))
    if old['head_sha'] != new['head_sha']:
        lines.append(f'HEAD：`{old["head_sha"]}` → `{new["head_sha"]}`')
    for field, key, label in (('releases', 'id', 'Release'), ('tags', 'ref', '标签')):
        before, after = ({x[key]: x for x in snapshot[field]} for snapshot in (old, new))
        for ident in sorted(set(before) | set(after)):
            a, b = before.get(ident), after.get(ident)
            if a == b:
                continue
            record = b or a
            name = record['tag_name'] if field == 'releases' else record['ref']
            action = '新增' if a is None else '删除' if b is None else '变更'
            detail = ''
            if field == 'tags' and a and b:
                detail = f'：`{a["object_sha"]}` → `{b["object_sha"]}`'
            if field == 'releases':
                detail = f'（ID {ident}；更新时间 {safe_text(record["updated_at"])}）'
            lines.append(f'{label}{action}：{safe_text(name)}{detail}')
    return lines


def impact_lines(api, repo, source, snapshot):
    baseline, head = source['commit'], snapshot['head_sha']
    link = f'https://github.com/{repo}/compare/{baseline}...{head}'
    lines = [f'[与 DokiTool 已采用提交比较]({link})；已采用：`{baseline}`。']
    if baseline == head:
        lines.append('默认分支仍与已采用代码一致；Release/标签对应的代码需结合相应版本另行审查。')
        return lines
    comparison = api.get(f'/repos/{repo}/compare/{baseline}...{head}?per_page=1')
    status = comparison.get('status')
    files = comparison.get('files')
    if status not in ('identical', 'ahead', 'behind', 'diverged') or not isinstance(files, list):
        raise WatchError('GitHub compare result is incomplete')
    if status in ('behind', 'diverged'):
        lines.append('上游历史状态为 ' + status + '，需人工核对历史，不能直接当作可合并升级。')
    if len(files) >= 300:
        lines.append('GitHub 返回 300 个或更多文件，文件列表可能截断；下面不能视为完整影响分析。')
    imported = set(source['imported_paths'])
    affected = [f for f in files if f.get('filename') in imported or f.get('previous_filename') in imported]
    outside = len(files) - len(affected)
    lines.append(f'返回文件中涉及当前采用范围 {len(affected)} 个，范围外 {outside} 个。')
    for file in affected[:20]:
        lines.append('- ' + safe_text(file.get('filename', ''), 300))
    if len(affected) > 20:
        lines.append(f'- 另有 {len(affected) - 20} 个，见比较链接。')
    sensitive = [f for f in files if re.search(r'(?i)(license|copying|notice|package(?:-lock)?\.json|composer|requirements|\.env|api/|services/)', f.get('filename', ''))]
    if sensitive:
        lines.append('涉及接口、依赖、许可或环境相关路径，采用前需人工检查兼容性、外部请求及凭据示例。')
    if not affected and len(files) < 300 and status == 'ahead':
        lines.append('本次返回的文件不在当前采用范围；未执行或引入上游代码。')
    return lines


def report_changes(api, sources, previous, current):
    sections = []
    for repo in UPSTREAMS:
        old, new = previous['repositories'][repo], current['repositories'][repo]
        changes = describe_changes(old, new)
        if changes:
            lines = [f'### [{repo}](https://github.com/{repo})', '', *('- ' + line for line in changes), '']
            lines.extend(impact_lines(api, repo, sources[repo], new))
            sections.append('\n'.join(lines))
    return '\n\n'.join(sections)


def make_body(summary, current, run_url, initial=False):
    heading = '上游检查已启用' if initial else '发现上游更新'
    observed = dt.datetime.fromisoformat(current['observed_at'].replace('Z', '+00:00')).astimezone(SHANGHAI)
    parts = [f'## {heading}', '', f'检查时间：{observed:%Y-%m-%d %H:%M:%S}（北京时间）。', '',
             summary or '本次没有发现相对已知基线的新变化。此 Issue 用于接收后续更新通知。', '',
             '仅检测和通知，不自动合并、修改采用基线或部署。后续评论携带最新观察状态；关闭此 Issue 不会停用检查。']
    if run_url:
        parts.extend(['', f'[查看 Actions 运行]({run_url})'])
    parts.extend(['', state_marker(current)])
    body = '\n'.join(parts)
    if len(body.encode('utf-8')) > MAX_BODY:
        raise WatchError('Notification exceeds the Issue body limit; state was not advanced')
    return body


def run_check(api, sources, seed, *, dry_run=False, verify_notification=False, now=None, run_url=None):
    seed = normalize_state(seed)
    issue, previous = find_issue(api)
    previous = previous or seed
    current = normalize_state({'schema': 1,
                               'observed_at': (now or dt.datetime.now(dt.timezone.utc)).isoformat(),
                               'repositories': {repo: collect_snapshot(api, repo) for repo in UPSTREAMS}})
    summary = report_changes(api, sources, previous, current)
    issue_url = f'https://github.com/{TARGET}/issues/{issue["number"]}' if issue else None
    result = {'changed': bool(summary), 'issue_created': False, 'notification_posted': False,
              'dry_run': dry_run, 'issue_url': issue_url, 'summary': summary or '两个上游均无新变化。'}
    if dry_run:
        return result
    if issue is None:
        body = make_body(summary, current, run_url, initial=True)
        created, _ = api.request('POST', '/repos/' + TARGET + '/issues',
                                 {'title': TITLE, 'body': body, 'assignees': [OWNER]})
        if type(created.get('number')) is not int:
            raise WatchError('Issue creation outcome is unknown; inspect the next run before retrying')
        result.update(issue_created=True, notification_posted=True,
                      issue_url=f'https://github.com/{TARGET}/issues/{created["number"]}')
    elif summary:
        body = make_body(summary, current, run_url)
        if issue.get('state') == 'closed':
            api.request('PATCH', f'/repos/{TARGET}/issues/{issue["number"]}', {'state': 'open'})
        # The human notification and observed snapshot are persisted in one POST.
        api.request('POST', f'/repos/{TARGET}/issues/{issue["number"]}/comments', {'body': body})
        result['notification_posted'] = True
    elif verify_notification:
        api.request('POST', f'/repos/{TARGET}/issues/{issue["number"]}/comments',
                    {'body': '通知通道验证：本条用于验证 GitHub Actions 的 Issue 通知权限，不代表上游有新更新，也不改变观察状态。'})
        result['notification_posted'] = True
    return result


def environment(env):
    if env.get('GITHUB_REPOSITORY', TARGET) != TARGET or env.get('GITHUB_REPOSITORY_OWNER', OWNER) != OWNER:
        raise WatchError('This watcher may only run for Brilliant666/DokiTool')
    if env.get('GITHUB_SERVER_URL', 'https://github.com') != 'https://github.com':
        raise WatchError('Only public github.com is supported')
    run_id = env.get('GITHUB_RUN_ID')
    if run_id is not None and not re.fullmatch(r'[0-9]+', run_id):
        raise WatchError('Invalid GitHub Actions run ID')
    return f'https://github.com/{TARGET}/actions/runs/{run_id}' if run_id else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Read and report without writing any Issue or comment')
    parser.add_argument('--verify-notification', action='store_true', help='Send an explicitly labeled notification-channel check')
    args = parser.parse_args()
    run_url = environment(os.environ)
    sources = load_sources()
    seed = json.loads((ROOT / '.github/upstream-watch-baseline.json').read_text(encoding='utf-8'))
    result = run_check(GitHub(os.environ.get('GITHUB_TOKEN')), sources, seed,
                       dry_run=args.dry_run, verify_notification=args.verify_notification, run_url=run_url)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary_file:
        with open(summary_file, 'a', encoding='utf-8') as output:
            output.write('## DokiTool 上游检查\n\n' + result['summary'] + '\n')
            if result['issue_url']:
                output.write('\n[通知 Issue](' + result['issue_url'] + ')\n')


if __name__ == '__main__':
    try:
        main()
    except (WatchError, KeyError, TypeError, AttributeError, OSError, ValueError) as error:
        # Do not echo HTTP response bodies, headers, tokens or upstream payloads.
        message = str(error) if isinstance(error, WatchError) else 'Invalid local configuration or upstream response; state was not advanced'
        print('Upstream check failed: ' + message, file=sys.stderr)
        sys.exit(1)
