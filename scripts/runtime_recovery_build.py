"""Offline verification of the exact curated build archive. Never extracts files."""
from __future__ import annotations
import base64
import hashlib
import gzip
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_MEMBERS = 4096
SUITES = (
    'report_pdf_recipients_test.py', 'report_pdf_email_test.py', 'report_pdf_layout_test.py',
    'report_pdf_unicode_test.py', 'report_pdf_volume_test.py', 'report_export_test.py',
    'report_export_evidence_test.py', 'report_corrections_test.py', 'report_manual_site_test.py',
    'supervisor_report_submission_test.py', 'template_source_support_test.py',
    'registration_email_test.py', 'invitation_email_test.py', 'migration_test.py', 'security_test.py',
)
ROOT_FILES = {'Dockerfile', 'requirements.txt', '.dockerignore', '.gcloudignore'}
AUX = {'test-requirements.txt': '.github/requirements-test.txt',
       'mutual-source-templates.json': 'docs/templates/mutual-source-templates.json'}
TEST_DOCKERFILE = (
    'ARG RUNTIME_IMAGE\nFROM ${RUNTIME_IMAGE}\n'
    'COPY test-requirements.txt /tmp/test-requirements.txt\n'
    'COPY mutual-source-templates.json /app/docs/templates/mutual-source-templates.json\n'
    'RUN python -m pip install --no-cache-dir -r /tmp/test-requirements.txt\n'
).encode()


def require(condition, label):
    if not condition:
        raise ValueError(label)


def strict_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'duplicate_build_config_key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_build_number')))


def canonical_config(project, region, commit):
    """Port of the reviewed build recipe, not imported from disposable output."""
    image = f'{region}-docker.pkg.dev/{project}/cloud-run-source-deploy/geo-backend:recipient-directory-20261110-{commit[:8]}'
    tests = image + '-tests'
    steps = [
        {'id': 'build-candidate', 'name': 'gcr.io/cloud-builders/docker', 'args': ['build', '-t', image, 'candidate']},
        {'id': 'build-tests-only', 'name': 'gcr.io/cloud-builders/docker',
         'args': ['build', '-f', 'Dockerfile.tests', '--build-arg', 'RUNTIME_IMAGE=' + image, '-t', tests, '.']},
    ]
    for suite in SUITES:
        args = ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs',
                '/tmp:rw,noexec,nosuid,size=512m', '--tmpfs', '/app/output:rw,noexec,nosuid,size=32m']
        for env in ('APP_ENV=test', 'AUTO_MIGRATE=false', 'DATABASE_URL=sqlite://',
                    'UPLOAD_DIR=/tmp/uploads', 'REGISTRATION_EMAIL_ENABLED=false',
                    'REPORT_PDF_EMAIL_WORKER_ENABLED=false', 'WORKER_INVITATION_TTL_HOURS=168'):
            args += ['-e', env]
        args += ['--entrypoint', 'python', tests, '/app/backend/' + suite]
        steps.append({'id': suite.removesuffix('.py').replace('_', '-'),
                      'name': 'gcr.io/cloud-builders/docker', 'args': args})
    return {'steps': steps, 'images': [image], 'timeout': '2400s',
            'serviceAccount': f'projects/{project}/serviceAccounts/794826041820-compute@developer.gserviceaccount.com',
            'options': {'logging': 'CLOUD_LOGGING_ONLY'}}


def read_archive(raw, expected):
    require(len(raw) <= MAX_ARCHIVE, 'build_archive_too_large')
    files, seen, total = {}, set(), 0
    directories = {str(parent) for path in expected for parent in PurePosixPath(path).parents if str(parent) != '.'}
    # Bound decompression BEFORE tarfile can allocate for a hostile PAX header.
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
        unpacked = compressed.read(MAX_TOTAL + 8 * 1024 * 1024 + 1)
    require(len(unpacked) <= MAX_TOTAL + 8 * 1024 * 1024, 'build_archive_expansion_limit')
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r|') as archive:
        for index, member in enumerate(archive):
            require(index < MAX_MEMBERS, 'too_many_build_members')
            name = member.name
            # gcloud archives may prefix every path with ./; permit exactly one.
            if name.startswith('./'):
                name = name[2:]
            if member.isdir():
                name = name.rstrip('/')
                if name in ('', '.'):
                    require('ROOT' not in seen, 'duplicate_build_member')
                    seen.add('ROOT')
                    continue
            require(name and not name.startswith('/') and '\\' not in name and
                    all(part not in ('', '.', '..') for part in name.split('/')),
                    'unsafe_build_member')
            require(name not in seen, 'duplicate_build_member')
            seen.add(name)
            require(member.isfile() or member.isdir(), 'build_links_or_special_files')
            require(not member.sparse, 'sparse_build_member')
            require(not member.pax_headers or set(member.pax_headers) <= {'mtime', 'atime', 'ctime'}, 'build_pax_override')
            if member.isdir():
                require(name in directories and member.size == 0, 'unknown_build_directory')
                continue
            require(name in expected, 'unknown_build_file')
            require(0 <= member.size <= MAX_FILE, 'build_member_too_large')
            total += member.size
            require(total <= MAX_TOTAL, 'build_archive_expansion_limit')
            stream = archive.extractfile(member)
            require(stream is not None, 'unreadable_build_member')
            value = stream.read(MAX_FILE + 1)
            require(len(value) == member.size, 'build_member_size_mismatch')
            files[name] = value
        require(not any(unpacked[archive.offset:]), 'trailing_build_archive_data')
    require(set(files) == set(expected), 'incomplete_build_context')
    return files


def validate_build_context(build, runtime, caller, git_files, archive_path, *, git_blob_files=None):
    """Require fresh generation-pinned provider bytes equal all canonical inputs.

    git_files must be exact bytes from the new verifier commit's Git archive.
    git_blob_files, when supplied, must be the two exact Git blobs from that same
    commit: the historical recipe used git show rather than Git archive for them.
    The caller separately binds sourceCommit/sourceArchiveSha256 and any old
    buildSourceCommit to local Git objects; no stale backend bytes are exempted.
    """
    require(type(build) is dict and type(runtime) is dict, 'invalid_build_metadata')
    require(caller['projectId'] == 'geo-attendance-system-db9ca', 'unsupported_build_recipe_project')
    require(build.get('id') == runtime['buildId'] and build.get('projectId') == caller['projectId']
            and build.get('status') == 'SUCCESS', 'build_not_bound_success')
    require(re.fullmatch('[0-9a-f]{40}', runtime['buildSourceCommit']) is not None, 'invalid_build_commit')
    require(re.fullmatch('[0-9a-f]{64}', runtime['buildArchiveSha256']) is not None, 'invalid_build_archive_hash')
    source = runtime['sourceArchiveObject']
    require(type(source) is dict and set(source) == {'bucket', 'object', 'generation'}, 'invalid_build_source')
    require(type(source['bucket']) is str and re.fullmatch('[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]', source['bucket']), 'unsafe_build_bucket')
    require(type(source['object']) is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}', source['object'])
            and all(part not in ('', '.', '..') for part in source['object'].split('/')), 'unsafe_build_object')
    require(type(source['generation']) is str and re.fullmatch('[1-9][0-9]{0,24}', source['generation']), 'unsafe_build_generation')
    require(build['sourceProvenance']['resolvedStorageSource'] == source and build['source']['storageSource'] == source,
            'build_source_object_mismatch')
    url = f"gs://{source['bucket']}/{source['object']}#{source['generation']}"
    hashes = build['sourceProvenance']['fileHashes']
    require(set(hashes) == {url}, 'ambiguous_build_source')
    values = [value['value'] for value in hashes[url]['fileHash'] if value['type'] == 'SHA256']
    require(len(values) == 1 and type(values[0]) is str and re.fullmatch('[A-Za-z0-9_-]{43}=', values[0]), 'invalid_build_provider_hash')
    digest = base64.b64decode(values[0], altchars=b'-_', validate=True)
    path = Path(archive_path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_ARCHIVE, 'invalid_build_archive_file')
    with path.open('rb') as handle:
        raw = handle.read(MAX_ARCHIVE + 1)
    require(len(raw) <= MAX_ARCHIVE and hashlib.sha256(raw).digest() == digest
            and hashlib.sha256(raw).hexdigest() == runtime['buildArchiveSha256'], 'build_archive_hash_mismatch')
    candidate = {name: value for name, value in git_files.items() if name in ROOT_FILES or name.startswith('backend/')}
    require(ROOT_FILES <= set(candidate) and all('backend/' + suite in candidate for suite in SUITES), 'incomplete_canonical_build_source')
    require(all(type(value) is bytes for value in candidate.values()), 'canonical_source_not_bytes')
    require(all(not name.endswith(('.db', '.sqlite', '.sqlite3', '.pyc')) and '/uploads/' not in name and
                not any(part == '.env' or part.startswith('.env.') for part in PurePosixPath(name).parts)
                for name in candidate), 'forbidden_build_source')
    blobs = git_files if git_blob_files is None else git_blob_files
    expected = {'candidate/' + name: value for name, value in candidate.items()}
    expected.update({target: blobs[source] for target, source in AUX.items()})
    expected.update({'Dockerfile.tests': TEST_DOCKERFILE, 'cloudbuild.json': b''})
    files = read_archive(raw, expected)
    for name, value in expected.items():
        if name not in {'Dockerfile.tests', 'cloudbuild.json'}:
            require(files[name] == value, 'build_input_bytes_differ')
    require(files['Dockerfile.tests'] in (TEST_DOCKERFILE, TEST_DOCKERFILE.replace(b'\n', b'\r\n')), 'test_dockerfile_changed')
    config = canonical_config(caller['projectId'], caller['region'], runtime['buildSourceCommit'])
    require(strict_json(files['cloudbuild.json']) == config, 'build_recipe_changed')
    # Provider-populated per-step status/timing/digest fields are observational.
    require(len(build['steps']) == len(config['steps']), 'provider_build_steps_changed')
    for actual, expected_step in zip(build['steps'], config['steps']):
        require(set(actual) <= set(expected_step) | {'status', 'timing', 'pullTiming', 'exitCode'}, 'provider_build_step_extra_fields')
        require({key: actual.get(key) for key in expected_step} == expected_step, 'provider_build_steps_changed')
        require(actual.get('status') == 'SUCCESS' and actual.get('exitCode') in (None, 0), 'provider_build_step_failed')
    for key in ('images', 'timeout', 'serviceAccount'):
        require(build.get(key) == config[key], 'provider_build_config_changed')
    # Cloud Build inserts defaults in options; unrequested execution settings
    # (env/secrets/volumes/pool/automap substitutions) remain disallowed.
    require(build.get('options', {}).get('logging') == 'CLOUD_LOGGING_ONLY' and
            set(build.get('options', {})) <= {'logging', 'logStreamingOption', 'pool', 'workerRelease'}, 'provider_build_options_changed')
    require('workerRelease' not in build.get('options', {}) or
            (type(build['options']['workerRelease']) is str and build['options']['workerRelease'] == 'legacy'),
            'unsupported_provider_worker_release')
    require(not build.get('options', {}).get('pool') and not any(build.get(k) for k in
            ('secrets', 'availableSecrets', 'substitutions', 'automapSubstitutions')), 'provider_build_extra_execution_config')
    images = build['results']['images']
    require(len(images) == 1 and images[0]['name'] == config['images'][0], 'build_image_tag_mismatch')
    expected_image = config['images'][0].rsplit(':', 1)[0] + '@' + images[0]['digest']
    require(re.fullmatch('sha256:[0-9a-f]{64}', images[0]['digest']) and runtime['image'] == expected_image, 'build_image_digest_mismatch')
