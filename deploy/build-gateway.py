"""Build pinned Overseer Gateway source with the reviewed project credential patch."""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
import tempfile


def prepare_source(source, profile, destination):
    commit = profile['commit']
    resolved = subprocess.check_output(
        ['git', '-C', str(source), 'rev-parse', commit + '^{commit}'], text=True,
    ).strip()
    if resolved != commit:
        raise ValueError('Gateway source must resolve to the pinned commit')
    patch = pathlib.Path(__file__).with_name(profile['patch'])
    if hashlib.sha256(patch.read_bytes()).hexdigest() != profile['patch_sha256']:
        raise ValueError('Gateway patch differs from its pinned SHA-256')
    # Only committed files enter the build; local edits, credentials and .git stay out.
    archive = subprocess.check_output(['git', '-C', str(source), 'archive', commit])
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        files.extractall(destination, filter='data')
    for options in (['--check'], []):
        subprocess.run(['git', 'apply', *options, str(patch.resolve())], cwd=destination, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Local checkout of the shared gateway')
    parser.add_argument('--tag', help='Override the image tag for a registry build')
    parser.add_argument('--check-only', action='store_true', help='Apply and test the exact patch without building an image')
    args = parser.parse_args()
    profile = json.loads(pathlib.Path(__file__).with_name('gateway-source.json').read_text())
    with tempfile.TemporaryDirectory(prefix='voxel-vault-gateway-') as directory:
        prepare_source(args.source, profile, directory)
        subprocess.run(['go', 'test', './cmd/gateway'], cwd=directory, check=True)
        if not args.check_only:
            revision = profile['commit'] + '+' + profile['patch_sha256'][:12]
            subprocess.run(['docker', 'build', '--build-arg', 'COMMIT_SHA=' + revision,
                            '--tag', args.tag or profile['image'], directory], check=True)


if __name__ == '__main__':
    main()
