"""Pure synthetic archive/provider fixtures. No Git, cloud, network or extraction."""
import base64
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import runtime_recovery_build as gate


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runtime-build-test-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'source.tgz'
        self.caller = {'projectId': 'geo-attendance-system-db9ca', 'region': 'australia-southeast1'}
        self.git = {name: (name + '\n').encode() for name in gate.ROOT_FILES}
        self.git.update({'backend/' + suite: b'print("offline")\n' for suite in gate.SUITES})
        self.git.update({'backend/app/assets/font.ttf': b'font\x00bytes', 'backend/app/main.py': b'pass\n'})
        self.git.update({name: b'canonical archive bytes\n' for name in gate.AUX.values()})
        self.blobs = {name: b'canonical git blob bytes\r\n' for name in gate.AUX.values()}
        self.runtime = {'buildId': 'build-fixture', 'buildSourceCommit': 'a' * 40,
                        'sourceCommit': 'b' * 40, 'sourceArchiveSha256': 'c' * 64,
                        'sourceArchiveObject': {'bucket': 'fixture-bucket', 'object': 'source/build.tgz', 'generation': '123'}}
        config = gate.canonical_config(self.caller['projectId'], self.caller['region'], self.runtime['buildSourceCommit'])
        self.files = {'candidate/' + name: value for name, value in self.git.items() if name in gate.ROOT_FILES or name.startswith('backend/')}
        self.files.update({name: self.blobs[source] for name, source in gate.AUX.items()})
        self.files.update({'Dockerfile.tests': gate.TEST_DOCKERFILE, 'cloudbuild.json': json.dumps(config).encode()})
        self.build = copy.deepcopy(config)
        self.build.update({'id': 'build-fixture', 'projectId': self.caller['projectId'], 'status': 'SUCCESS',
                           'source': {'storageSource': self.runtime['sourceArchiveObject']},
                           'sourceProvenance': {'resolvedStorageSource': self.runtime['sourceArchiveObject']},
                           'results': {'images': [{'name': config['images'][0], 'digest': 'sha256:' + 'd' * 64}]}})
        for step in self.build['steps']:
            step['status'] = 'SUCCESS'
        self.runtime['image'] = config['images'][0].rsplit(':', 1)[0] + '@sha256:' + 'd' * 64
        self.pack()

    def pack(self, extra=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            for name, value in self.files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(value)
                archive.addfile(entry, io.BytesIO(value))
            if extra:
                extra(archive)
        self.bind(buffer.getvalue())

    def bind(self, raw):
        self.path.write_bytes(raw)
        digest = hashlib.sha256(raw).digest()
        self.runtime['buildArchiveSha256'] = digest.hex()
        self.build['sourceProvenance']['fileHashes'] = {
            'gs://fixture-bucket/source/build.tgz#123': {'fileHash': [
                {'type': 'MD5', 'value': 'irrelevant'},
                {'type': 'SHA256', 'value': base64.urlsafe_b64encode(digest).decode()}]}}

    def validate(self):
        gate.validate_build_context(self.build, self.runtime, self.caller, self.git, self.path, git_blob_files=self.blobs)

    def test_exact_context_and_git_blob_treatment(self):
        self.validate()
        self.files['Dockerfile.tests'] = gate.TEST_DOCKERFILE.replace(b'\n', b'\r\n')
        self.pack()
        self.validate()
        with self.assertRaises(ValueError):
            gate.validate_build_context(self.build, self.runtime, self.caller, self.git, self.path)

    def test_every_candidate_asset_bound(self):
        for name in list(self.files):
            with self.subTest(name=name):
                old = self.files[name]
                self.files[name] += b'changed'
                self.pack()
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    self.validate()
                self.files[name] = old

    def test_omitted_and_unknown_file(self):
        del self.files['candidate/backend/app/assets/font.ttf']
        self.pack()
        with self.assertRaises(ValueError): self.validate()
        self.files['candidate/unexpected'] = b'unknown'
        self.pack()
        with self.assertRaises(ValueError): self.validate()

    def test_unsafe_members(self):
        cases = [('candidate/Dockerfile', tarfile.REGTYPE), ('../escape', tarfile.REGTYPE),
                 ('/absolute', tarfile.REGTYPE), ('candidate/../escape', tarfile.REGTYPE),
                 ('candidate/link', tarfile.SYMTYPE), ('candidate/hard', tarfile.LNKTYPE),
                 ('candidate/device', tarfile.CHRTYPE)]
        for name, kind in cases:
            with self.subTest(name=name):
                def extra(archive):
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.linkname = 'candidate/Dockerfile' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                    archive.addfile(entry)
                self.pack(extra)
                with self.assertRaises(ValueError): self.validate()

    def test_bounded_archive_and_member(self):
        with patch.object(gate, 'MAX_ARCHIVE', 8):
            with self.assertRaises(ValueError): self.validate()
        with patch.object(gate, 'MAX_FILE', 8):
            with self.assertRaises(ValueError): self.validate()
        with patch.object(gate, 'MAX_MEMBERS', 2):
            with self.assertRaises(ValueError): self.validate()
        with patch.object(gate, 'MAX_TOTAL', 8):
            with self.assertRaises(ValueError): self.validate()
        self.bind(gzip.compress(b'\0' * (9 * 1024 * 1024)))
        with patch.object(gate, 'MAX_TOTAL', 8):
            with self.assertRaises(ValueError): self.validate()

    def test_provider_digest_and_generation(self):
        self.path.write_bytes(self.path.read_bytes() + b'changed')
        with self.assertRaises(ValueError): self.validate()
        self.pack()
        hashes = self.build['sourceProvenance']['fileHashes']
        hashes['gs://fixture-bucket/source/build.tgz'] = hashes.pop('gs://fixture-bucket/source/build.tgz#123')
        with self.assertRaises(ValueError): self.validate()

    def test_build_provider_execution_bound(self):
        mutations = [lambda b: b.update(status='FAILURE'), lambda b: b.update(projectId='other'),
                     lambda b: b['steps'].pop(), lambda b: b['steps'][0]['args'].append('--secret'),
                     lambda b: b['steps'][2].update(env=['SMTP_PASSWORD=bad']),
                     lambda b: b['steps'][2].update(status='FAILURE'),
                     lambda b: b['options'].update(env=['INJECT=true']),
                     lambda b: b.update(substitutions={'_ATTACK': 'value'}),
                     lambda b: b['results']['images'][0].update(digest='sha256:' + 'e' * 64)]
        baseline = copy.deepcopy(self.build)
        for mutate in mutations:
            self.build = copy.deepcopy(baseline)
            mutate(self.build)
            with self.assertRaises(ValueError): self.validate()

    def test_network_smtp_or_suite_recipe_change(self):
        for change in ('network', 'smtp', 'suite', 'extra'):
            config = gate.canonical_config(self.caller['projectId'], self.caller['region'], self.runtime['buildSourceCommit'])
            if change == 'network': config['steps'][2]['args'][4] = 'host'
            if change == 'smtp': config['steps'][2]['args'].extend(['-e', 'SMTP_HOST=example.test'])
            if change == 'suite': config['steps'].pop()
            if change == 'extra': config['secrets'] = []
            self.files['cloudbuild.json'] = json.dumps(config).encode()
            self.pack()
            with self.assertRaises(ValueError): self.validate()

    def test_duplicate_json_and_trailing_tar(self):
        self.files['cloudbuild.json'] = b'{"steps":[],"steps":[]}'
        self.pack()
        with self.assertRaises(ValueError): self.validate()
        self.setUp()
        raw = gzip.decompress(self.path.read_bytes()) + b'unknown trailing bytes'
        self.bind(gzip.compress(raw))
        with self.assertRaises(ValueError): self.validate()

    def test_unsupported_project(self):
        self.caller['projectId'] = 'other-project'
        with self.assertRaisesRegex(ValueError, 'unsupported_build_recipe_project'): self.validate()

    def test_provider_legacy_worker_release_only(self):
        self.validate()
        self.build['options']['workerRelease'] = 'legacy'
        self.validate()
        for value in ('other', '', None, True, 1, {}, []):
            self.build['options']['workerRelease'] = value
            with self.assertRaisesRegex(ValueError, 'unsupported_provider_worker_release'):
                self.validate()


if __name__ == '__main__':
    unittest.main()
