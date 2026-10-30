"""Independent contract examples and adversarial checks; all inputs synthetic."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('unified_validation', ROOT / 'scripts/validate-unified-schema.py')
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
EXAMPLES = ROOT / 'docs/schema/unified-v1/examples'


def example(number):
    return json.loads(next(EXAMPLES.glob(f'{number:02}-*.json')).read_text(encoding='utf-8'))


def item(response):
    return response['data']['items'][0]


def variant(response):
    return item(response)['variants'][0]


class ContractTests(unittest.TestCase):
    def test_deferred_variants_never_promise_a_file_or_measured_4k(self):
        response = example(27)
        contract.validate(response)
        pending = item(response)['variants'][-1]
        for key, value in [('delivery', {'kind': 'file', 'sources': [{'url': 'https://media.example.test/false.mp4'}]}), ('metadata', {'width': 3840, 'height': 2160, 'evidence': 'probe'})]:
            changed = deepcopy(response)
            item(changed)['variants'][-1][key] = value
            with self.assertRaises(ValueError):
                contract.validate(changed)
        changed = deepcopy(response)
        item(changed)['default']['variant_id'] = pending['id']
        with self.assertRaises(ValueError):
            contract.validate(changed)
        item(response)['variants'] = [pending]
        item(response)['default'] = None
        item(response)['default_unavailable_reason'] = 'needs_resolve'
        contract.validate(response)

    def rejects(self, number, mutate):
        response = example(number)
        mutate(response)
        with self.assertRaises(ValueError):
            contract.validate(response)

    def test_all_design_examples_independently_validate(self):
        for path in sorted(EXAMPLES.glob('*.json')):
            with self.subTest(path=path.name):
                contract.validate(json.loads(path.read_text(encoding='utf-8')))

    def test_structure_rejects_old_and_unknown_shapes(self):
        changes = [
            lambda r: r.update(schema_version='0.9'),
            lambda r: r.update(code=200),
            lambda r: r['data'].update(url='https://media.example.test/old.mp4'),
            lambda r: r['data'].update(video_backup=[]),
            lambda r: item(r).pop('default'),
            lambda r: item(r).update(id=123),
            lambda r: variant(r).update(resources=[]),
            lambda r: variant(r)['delivery'].update(kind='mystery'),
            lambda r: variant(r)['delivery']['sources'][0].update(headers={'Cookie': 'placeholder'}),
            lambda r: variant(r)['delivery']['sources'][0].update(size_bytes=0),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.rejects(2, change)

    def test_default_is_an_exact_local_file_reference(self):
        changes = [
            lambda r: item(r)['default'].update(variant_id='missing'),
            lambda r: item(r)['default'].update(url='https://media.example.test/another.mp4'),
            lambda r: item(r)['default'].update(access='relay'),
            lambda r: item(r)['default'].update(expires_at='2099-01-01T00:00:00Z'),
            lambda r: item(r).update(default=None, default_unavailable_reason='unavailable'),
            lambda r: item(r).update(default_unavailable_reason='unavailable'),
            lambda r: variant(r)['delivery']['sources'].append({'url': 'https://media.example.test/backup.mp4'}),
            lambda r: variant(r)['delivery']['sources'][0].update(availability='unavailable'),
            lambda r: variant(r)['delivery']['sources'][0].update(expires_at='2000-01-01T00:00:00Z'),
            lambda r: r['data'].update(default_item_id='missing'),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.rejects(2, change)
        self.rejects(16, lambda r: item(r)['default'].update(variant_id='4k-mux'))
        self.rejects(16, lambda r: item(r).pop('higher_quality_variants'))
        self.rejects(16, lambda r: item(r)['higher_quality_variants'][0].update(requires=['dash']))
        self.rejects(16, lambda r: item(r)['higher_quality_variants'].append(deepcopy(item(r)['higher_quality_variants'][0])))
        self.rejects(16, lambda r: item(r)['variants'][1]['delivery']['resources'][1]['delivery']['sources'][0].update(availability='unavailable'))

    def test_known_higher_file_cannot_be_hidden(self):
        r = example(16)
        high = deepcopy(variant(r))
        high.update(id='4k-file', metadata={'width': 3840, 'height': 2160, 'evidence': 'probe'})
        high['delivery']['sources'][0]['url'] = 'https://media.example.test/high.mp4'
        item(r)['variants'].append(high)
        with self.assertRaises(ValueError):
            contract.validate(r)

    def test_source_identity_expiry_and_null_reason(self):
        self.rejects(18, lambda r: r['data'].pop('generated_at'))
        self.rejects(18, lambda r: item(r)['default'].pop('source_id'))
        self.rejects(21, lambda r: item(r).update(default_unavailable_reason='processing_required'))
        self.rejects(22, lambda r: item(r).update(default_unavailable_reason='needs_refresh'))
        self.rejects(17, lambda r: item(r).update(default_unavailable_reason='needs_resolve'))

    def test_quality_and_composition_are_not_labels(self):
        self.rejects(16, lambda r: variant(r)['metadata'].pop('evidence'))
        self.rejects(16, lambda r: variant(r)['metadata'].update(evidence='mixed', field_evidence={'width': 'probe'}))
        self.rejects(16, lambda r: item(r)['variants'][1]['delivery']['resources'][0]['metadata'].update(has_audio=True))
        self.rejects(16, lambda r: item(r)['variants'][1].update(metadata={'width': 1280, 'height': 720, 'evidence': 'upstream'}))
        self.rejects(14, lambda r: variant(r).update(metadata={'width': 3840, 'height': 2160, 'evidence': 'upstream'}))
        self.rejects(11, lambda r: variant(r)['metadata'].update(mime_type='video/mp4'))

    def test_query_bytes_preserved_and_access_restricted(self):
        for url in ['https://user:pass@media.example.test/v', 'https://media.example.test/v#part', 'https://media.example.test/\\v', 'file:///tmp/video.mp4']:
            with self.subTest(url=url):
                def change(r):
                    variant(r)['delivery']['sources'][0]['url'] = url
                    item(r)['default']['url'] = url
                self.rejects(2, change)
        r = example(2)
        url = 'https://media.example.test/v.mp4?sig=abc%23def%2Bghi%2Fj%3D'
        variant(r)['delivery']['sources'][0]['url'] = url
        item(r)['default']['url'] = url
        contract.validate(r)
        self.assertEqual(item(r)['default']['url'], url)

    def test_reordering_and_browser_fetch_do_not_reselect(self):
        r = example(18)
        selected = deepcopy(item(r)['default'])
        item(r)['variants'].reverse()
        for v in item(r)['variants']:
            v['delivery']['sources'].reverse()
            for s in v['delivery']['sources']:
                s['browser_fetch'] = 'blocked'
        contract.validate(r)
        self.assertEqual(item(r)['default'], selected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
