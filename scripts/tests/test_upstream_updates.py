"""Offline behavioral tests. No real GitHub requests or notifications."""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

SCRIPT = Path(__file__).resolve().parents[1] / 'check-upstream-updates.py'
SPEC = importlib.util.spec_from_file_location('upstream_watch', SCRIPT)
watch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch)
NOW = dt.datetime(2026, 10, 29, 1, 0, tzinfo=dt.timezone.utc)
BOT = {'login': watch.BOT, 'type': 'Bot'}


def seed_state():
    return {'schema': 1, 'observed_at': '2026-10-28T01:00:00Z', 'repositories': {
        repo: {'default_branch': 'main', 'head_sha': str(index) * 40, 'releases': [], 'tags': []}
        for index, repo in enumerate(watch.UPSTREAMS, 1)}}


def sources(seed):
    return {name: {'commit': value['head_sha'], 'imported_paths': ['api/parser.php', 'package.json']}
            for name, value in seed['repositories'].items()}


def managed_issue(seed, state='open'):
    return {'number': 17, 'title': watch.TITLE, 'user': copy.deepcopy(BOT),
            'body': 'Monitoring enabled.\n' + watch.state_marker(seed), 'state': state}


class FakeGitHub:
    def __init__(self, seed, issue=None):
        self.snapshots = copy.deepcopy(seed['repositories'])
        self.issues = [copy.deepcopy(issue)] if issue else []
        self.comments = []
        self.writes = []
        self.reads = []
        self.fail_read = None
        self.fail_post = False
        self.fail_after_post = False
        self.fail_after_create = False
        self.comparison = {'status': 'ahead', 'files': [{'filename': 'api/parser.php'}]}

    def get(self, path):
        self.reads.append(path)
        if self.fail_read and self.fail_read in path:
            raise watch.WatchError('Synthetic API read failure')
        for repo, snapshot in self.snapshots.items():
            prefix = '/repos/' + repo
            if path == prefix:
                return {'default_branch': snapshot['default_branch']}
            if path.startswith(prefix + '/git/ref/heads/'):
                return {'object': {'sha': snapshot['head_sha']}}
            if path.startswith(prefix + '/compare/'):
                return copy.deepcopy(self.comparison)
        raise AssertionError('Unexpected GET ' + path)

    def items(self, path):
        self.reads.append(path)
        if self.fail_read and self.fail_read in path:
            raise watch.WatchError('Synthetic API list failure')
        if path.startswith('/repos/' + watch.TARGET + '/issues?'):
            return copy.deepcopy(self.issues)
        if '/issues/17/comments?' in path:
            return copy.deepcopy(self.comments)
        for repo, snapshot in self.snapshots.items():
            prefix = '/repos/' + repo
            if path.startswith(prefix + '/releases?'):
                return copy.deepcopy(snapshot['releases'])
            if path.startswith(prefix + '/git/matching-refs/tags/'):
                return [{'ref': t['ref'], 'object': {'sha': t['object_sha'], 'type': t['type']}}
                        for t in snapshot['tags']]
        raise AssertionError('Unexpected list ' + path)

    def request(self, method, path, data=None):
        if method == 'POST' and self.fail_post:
            raise watch.WatchError('Synthetic notification failure')
        self.writes.append((method, path, copy.deepcopy(data)))
        if method == 'PATCH':
            self.issues[0]['state'] = data['state']
            return copy.deepcopy(self.issues[0]), {}
        if path.endswith('/comments'):
            self.comments.append({'id': 100 + len(self.comments), 'user': copy.deepcopy(BOT), 'body': data['body']})
            if self.fail_after_post:
                self.fail_after_post = False
                raise watch.WatchError('Synthetic response loss after successful POST')
            return copy.deepcopy(self.comments[-1]), {}
        if method == 'POST' and path.endswith('/issues'):
            issue = {'number': 17, 'user': copy.deepcopy(BOT), 'state': 'open', **copy.deepcopy(data)}
            self.issues.append(issue)
            if self.fail_after_create:
                self.fail_after_create = False
                raise watch.WatchError('Synthetic response loss after Issue creation')
            return copy.deepcopy(issue), {}
        raise AssertionError('Unexpected mutation')


class WatchBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.seed = seed_state()
        self.sources = sources(self.seed)

    def run_watch(self, api, **kwargs):
        return watch.run_check(api, self.sources, self.seed, now=NOW, **kwargs)

    def test_unchanged_existing_issue_does_not_write(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        result = self.run_watch(api)
        self.assertFalse(result['changed'])
        self.assertFalse(result['notification_posted'])
        self.assertEqual(api.writes, [])

    def test_first_success_creates_assigned_issue_with_observed_state(self):
        api = FakeGitHub(self.seed)
        result = self.run_watch(api)
        self.assertTrue(result['issue_created'])
        method, path, payload = api.writes[0]
        self.assertEqual((method, path), ('POST', '/repos/Brilliant666/DokiTool/issues'))
        self.assertEqual(payload['assignees'], ['Brilliant666'])
        self.assertIn('本次没有发现', payload['body'])
        self.assertIn('2026-10-29 09:00:00', payload['body'])
        self.assertEqual(watch.extract_state(payload['body'])['repositories'], self.seed['repositories'])
        self.run_watch(api)
        self.assertEqual(len(api.writes), 1)

    def test_first_run_does_not_swallow_changes_since_seed(self):
        api = FakeGitHub(self.seed)
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        result = self.run_watch(api)
        self.assertTrue(result['changed'])
        self.assertIn('a' * 40, api.writes[0][2]['body'])
        self.assertIn('涉及当前采用范围 1 个', result['summary'])
        self.assertEqual(self.sources[watch.UPSTREAMS[0]]['commit'], '1' * 40)

    def test_commit_release_tag_and_branch_changes_are_reported_once(self):
        release = {'id': 1, 'tag_name': 'v1', 'published_at': '2026-10-28T00:00:00Z',
                   'updated_at': '2026-10-28T00:00:00Z', 'prerelease': False}
        tag = {'ref': 'refs/tags/v1', 'object_sha': 'b' * 40, 'type': 'tag'}
        changes = [
            lambda s: s.update(head_sha='a' * 40),
            lambda s: s.update(default_branch='new-main'),
            lambda s: s['releases'].append(copy.deepcopy(release)),
            lambda s: s['tags'].append(copy.deepcopy(tag)),
        ]
        for change in changes:
            with self.subTest(change=change):
                api = FakeGitHub(self.seed, managed_issue(self.seed))
                change(api.snapshots[watch.UPSTREAMS[0]])
                self.assertTrue(self.run_watch(api)['changed'])
                self.assertEqual(len(api.writes), 1)
                self.assertIn('/comments', api.writes[0][1])
                state = watch.extract_state(api.writes[0][2]['body'])
                self.assertEqual(state['repositories'], api.snapshots)
                self.assertFalse(self.run_watch(api)['changed'])
                self.assertEqual(len(api.writes), 1)

    def test_release_edits_deletions_and_tag_moves_deletions(self):
        base = copy.deepcopy(self.seed)
        base['repositories'][watch.UPSTREAMS[0]]['releases'] = [{
            'id': 12, 'tag_name': 'v1', 'published_at': '2026-10-28T00:00:00Z',
            'updated_at': '2026-10-28T00:00:00Z', 'prerelease': False}]
        base['repositories'][watch.UPSTREAMS[0]]['tags'] = [{
            'ref': 'refs/tags/v1', 'object_sha': 'b' * 40, 'type': 'tag'}]
        cases = [
            (lambda s: s['releases'][0].update(updated_at='2026-10-29T00:00:00Z'), 'Release变更'),
            (lambda s: s['releases'].clear(), 'Release删除'),
            (lambda s: s['tags'][0].update(object_sha='c' * 40), '标签变更'),
            (lambda s: s['tags'].clear(), '标签删除'),
        ]
        for change, expected in cases:
            with self.subTest(expected=expected):
                api = FakeGitHub(base, managed_issue(base))
                change(api.snapshots[watch.UPSTREAMS[0]])
                result = self.run_watch(api)
                self.assertIn(expected, result['summary'])
                self.assertFalse(self.run_watch(api)['changed'])

    def test_irrelevant_release_download_metadata_is_ignored(self):
        release = {'id': 12, 'tag_name': 'v1', 'published_at': None,
                   'updated_at': '2026-10-28T00:00:00Z', 'prerelease': True}
        self.seed['repositories'][watch.UPSTREAMS[0]]['releases'] = [release]
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        api.snapshots[watch.UPSTREAMS[0]]['releases'][0]['assets'] = [{'download_count': 999}]
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(api.writes, [])

    def test_closed_issue_is_reused_and_only_reopened_for_a_change(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed, state='closed'))
        self.run_watch(api)
        self.assertEqual(api.writes, [])
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        self.run_watch(api)
        self.assertEqual([x[0] for x in api.writes], ['PATCH', 'POST'])
        self.assertEqual(api.writes[0][2], {'state': 'open'})
        self.assertEqual(len(api.issues), 1)

    def test_human_state_comments_are_ignored_latest_bot_state_wins(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        api.comments = [{'id': 500, 'user': {'login': 'untrusted', 'type': 'User'}, 'body': watch.MARKER + 'bad'}]
        self.assertFalse(self.run_watch(api)['changed'])
        newer = copy.deepcopy(self.seed)
        newer['repositories'][watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        api.comments += [{'id': 2, 'user': BOT, 'body': watch.state_marker(newer)},
                         {'id': 1, 'user': BOT, 'body': watch.state_marker(self.seed)}]
        api.snapshots = copy.deepcopy(newer['repositories'])
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(api.writes, [])

    def test_malformed_bot_state_or_duplicate_managed_issue_fails_closed(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        api.comments = [{'id': 1, 'user': BOT, 'body': watch.MARKER + 'invalid -->'}]
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(api.writes, [])
        api.comments = []
        api.issues.append(copy.deepcopy(api.issues[0]))
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)

    def test_nonbot_issue_cannot_supply_observation_state(self):
        fake_issue = managed_issue(self.seed)
        fake_issue['user'] = {'login': 'someone', 'type': 'User'}
        api = FakeGitHub(self.seed, fake_issue)
        result = self.run_watch(api)
        self.assertTrue(result['issue_created'])

    def test_missing_managed_issue_marker_does_not_create_duplicate(self):
        issue = managed_issue(self.seed)
        issue['body'] = 'The state marker was accidentally deleted.'
        api = FakeGitHub(self.seed, issue)
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(api.writes, [])
        self.assertEqual(len(api.issues), 1)

    def test_partial_read_failure_and_compare_failure_do_not_notify(self):
        for failure in ('shortvideo-html/releases', 'compare/'):
            with self.subTest(failure=failure):
                api = FakeGitHub(self.seed, managed_issue(self.seed))
                api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
                api.fail_read = failure
                with self.assertRaises(watch.WatchError):
                    self.run_watch(api)
                self.assertEqual(api.writes, [])
                self.assertEqual(watch.extract_state(api.issues[0]['body'])['repositories'], self.seed['repositories'])

    def test_failed_notification_keeps_old_state_and_successful_retry_posts_once(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        api.fail_post = True
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(api.comments, [])
        api.fail_post = False
        self.run_watch(api)
        self.run_watch(api)
        self.assertEqual(len(api.comments), 1)

    def test_lost_post_response_does_not_duplicate_notification_on_retry(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        api.fail_after_post = True
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(len(api.comments), 1)
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(len(api.comments), 1)

    def test_lost_creation_response_does_not_create_duplicate_issue(self):
        api = FakeGitHub(self.seed)
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        api.fail_after_create = True
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(len(api.issues), 1)
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(len(api.issues), 1)
        self.assertEqual(len(api.writes), 1)

    def test_dry_run_never_writes_even_when_verifying_or_changes_exist(self):
        api = FakeGitHub(self.seed)
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        self.assertTrue(self.run_watch(api, dry_run=True, verify_notification=True)['changed'])
        self.assertEqual(api.writes, [])

    def test_explicit_notification_probe_has_no_state_marker(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        self.run_watch(api, verify_notification=True)
        body = api.writes[0][2]['body']
        self.assertIn('不代表上游有新更新', body)
        self.assertNotIn(watch.MARKER, body)
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(len(api.writes), 1)

    def test_compare_truncation_divergence_and_renamed_import_are_explicit(self):
        api = FakeGitHub(self.seed, managed_issue(self.seed))
        api.snapshots[watch.UPSTREAMS[0]]['head_sha'] = 'a' * 40
        api.comparison = {'status': 'diverged', 'files': [
            {'filename': 'new/path.php', 'previous_filename': 'api/parser.php'},
            *({'filename': 'outside/' + str(i)} for i in range(299))]}
        summary = self.run_watch(api)['summary']
        self.assertIn('diverged', summary)
        self.assertIn('可能截断', summary)
        self.assertIn('涉及当前采用范围 1 个', summary)


class BoundaryTests(unittest.TestCase):
    def test_all_pages_are_read_and_external_pagination_is_rejected(self):
        api = watch.GitHub('dummy-token')
        path = '/repos/' + watch.TARGET + '/issues/17/comments?per_page=100'
        next_url = 'https://api.github.com' + path + '&page=2'
        api.request = Mock(side_effect=[([{'id': 1}], {'Link': '<' + next_url + '>; rel="next"'}),
                                       ([{'id': 2}], {})])
        self.assertEqual(api.items(path), [{'id': 1}, {'id': 2}])
        self.assertEqual(api.request.call_count, 2)
        api.request = Mock(return_value=([], {'Link': '<https://evil.test/steal>; rel="next"'}))
        with self.assertRaises(watch.WatchError):
            api.items(path)
        self.assertEqual(api.request.call_count, 1)

    def test_cyclic_pagination_fails(self):
        api = watch.GitHub('dummy-token')
        path = '/repos/' + watch.TARGET + '/issues?per_page=100'
        api.request = Mock(return_value=([], {'Link': '<https://api.github.com' + path + '>; rel="next"'}))
        with self.assertRaises(watch.WatchError):
            api.items(path)

    def test_only_target_issue_writes_are_allowed(self):
        opener = Mock()
        api = watch.GitHub('dummy-token', opener=opener)
        paths = [('PUT', '/repos/Brilliant666/DokiTool/contents/README.md', {}),
                 ('POST', '/repos/jiuhunwl/short_videos/issues', {}),
                 ('PATCH', '/repos/Brilliant666/DokiTool/issues/17', {'body': 'overwrite'}),
                 ('DELETE', '/repos/Brilliant666/DokiTool/issues/17', None)]
        for method, path, payload in paths:
            with self.subTest(method=method, path=path):
                with self.assertRaises(watch.WatchError):
                    api.request(method, path, payload)
        opener.open.assert_not_called()

    def test_token_is_not_forwarded_to_another_host_or_redirect(self):
        for url in ['http://api.github.com/repos/Brilliant666/DokiTool',
                    'https://api.github.com.evil.test/repos/Brilliant666/DokiTool',
                    'https://user@api.github.com/repos/Brilliant666/DokiTool',
                    'https://api.github.com/repos/another/repo',
                    'https://api.github.com/repos/Brilliant666/DokiTool#fragment']:
            with self.subTest(url=url), self.assertRaises(watch.WatchError):
                watch.validate_api_url(url)
        self.assertIsNone(watch.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))

    def test_environment_is_bound_to_target_and_public_github(self):
        self.assertEqual(watch.environment({'GITHUB_RUN_ID': '123'}),
                         'https://github.com/Brilliant666/DokiTool/actions/runs/123')
        for env in [{'GITHUB_REPOSITORY': 'other/repo'}, {'GITHUB_REPOSITORY_OWNER': 'other'},
                    {'GITHUB_SERVER_URL': 'https://evil.test'}, {'GITHUB_RUN_ID': '123/evil'}]:
            with self.subTest(env=env), self.assertRaises(watch.WatchError):
                watch.environment(env)

    def test_upstream_strings_cannot_create_mentions_html_or_markdown_links(self):
        text = watch.safe_text('@Brilliant666\n[click](https://evil.test) <script> `code`')
        self.assertNotIn('@', text)
        self.assertNotIn('\n', text)
        self.assertNotIn('<script>', text)
        self.assertIn('\\[click\\]\\(', text)
        self.assertIn('\\`code\\`', text)

    def test_malformed_snapshot_and_oversized_notice_fail(self):
        seed = seed_state()
        with self.assertRaises(watch.WatchError):
            watch.normalize_state({'schema': 1, 'observed_at': 'invalid', 'repositories': {}})
        bad = copy.deepcopy(seed)
        bad['repositories'][watch.UPSTREAMS[0]]['head_sha'] = 'not-a-sha'
        with self.assertRaises(watch.WatchError):
            watch.normalize_state(bad)
        with self.assertRaises(watch.WatchError):
            watch.make_body('x' * watch.MAX_BODY, seed, None)


if __name__ == '__main__':
    unittest.main()
