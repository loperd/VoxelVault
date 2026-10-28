"""Verify the maintenance sequence without contacting Kubernetes or PostgreSQL."""
import importlib.util
import base64
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ledger_upgrade', ROOT / 'deploy/upgrade-ledger.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class FakeKubernetes:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def upgrade_chart(self, args, replicas=0):
        self.calls.append((('helm', 'upgrade', str(replicas)), None))

    def run(self, *args, document=None, timeout=60):
        self.calls.append((args, document))
        if args[0] == 'get':
            return json.dumps({'items': []})
        if self.fail and args[0] == 'wait':
            raise RuntimeError('migration/grants failed')
        return ''


class LedgerUpgradeTest(unittest.TestCase):
    def fixture(self, directory):
        args = SimpleNamespace(image='registry.example/api:next', namespace='test', timeout=30,
                               operator_secret='operator-only', runtime_secret='runtime-only',
                               configmap='application-env', runtime_role='ledger_runtime', image_pull_secret=None,
                               state_file=Path(directory) / 'upgrade.json')
        state = {'id': 'fixture', 'attempt': 0, 'complete': False, 'writers': [
            {'deployment': 'api', 'container': 'api', 'replicas': 2, 'selector': 'app=api'},
            {'deployment': 'worker', 'container': 'worker', 'replicas': 1, 'selector': 'app=worker'}]}
        return args, state

    def test_drains_all_writers_before_migration_and_restores_only_new_images(self):
        with tempfile.TemporaryDirectory() as directory:
            args, state = self.fixture(directory)
            kube = FakeKubernetes()
            upgrade.execute(kube, args, state)
            calls = [call for call, _ in kube.calls]
            create = next(i for i, call in enumerate(calls) if call[0] == 'create')
            self.assertEqual(calls[:2], [('scale', 'deployment/api', '--replicas=0'),
                                         ('scale', 'deployment/worker', '--replicas=0')])
            self.assertEqual(sum(call[:2] == ('get', 'pods') for call in calls[:create]), 2)
            images = [i for i, call in enumerate(calls) if call[:2] == ('set', 'image')]
            restores = [i for i, call in enumerate(calls) if call[0] == 'scale' and call[-1] != '--replicas=0']
            self.assertLess(max(images), min(restores))
            chart = next(i for i, call in enumerate(calls) if call[:2] == ('helm', 'upgrade'))
            waited = next(i for i, call in enumerate(calls) if call[0] == 'wait')
            self.assertLess(waited, chart)
            self.assertLess(chart, min(restores))
            self.assertEqual([call[-1] for call in calls if call[:2] == ('helm', 'upgrade')], ['0', '2'])
            self.assertTrue(state['complete'])
            self.assertTrue(json.loads(args.state_file.read_text())['complete'])
            job = next(document for call, document in kube.calls if call[0] == 'create')
            pod = job['spec']['template']['spec']
            self.assertFalse(pod['automountServiceAccountToken'])
            self.assertEqual([c['command'][0] for c in pod['initContainers']], ['/wallet-migrate', '/runtime-grants'])
            self.assertEqual(pod['containers'][0]['command'], ['/economy-cutover', '-action', 'check'])
            self.assertEqual({item['valueFrom']['secretKeyRef']['name'] for c in pod['initContainers'] for item in c['env']}, {'operator-only'})
            self.assertEqual({item['valueFrom']['secretKeyRef']['name'] for item in pod['containers'][0]['env']}, {'runtime-only'})
            self.assertTrue(all(c['securityContext']['runAsUser'] == 65532 for c in pod['initContainers'] + pod['containers']))

    def test_chart_update_keeps_writers_stopped_and_never_uses_atomic_rollback(self):
        args = SimpleNamespace(image='registry.example/api:new', gateway_image='registry.example/gateway:new',
                               context='fixture', namespace='test', helm_release='release', chart=Path('/chart'),
                               helm_values=[Path('/values.yaml')], gateway_secret='gateway-only',
                               runtime_secret='runtime-only', timeout=30)
        with patch.object(upgrade.subprocess, 'run') as run:
            upgrade.Kubernetes('fixture', 'test').upgrade_chart(args)
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ['helm', 'upgrade', 'release'])
        self.assertNotIn('--atomic', command)
        self.assertIn('replicaCount=0', command)
        self.assertIn('image.tag="new"', command)
        self.assertIn('gateway.image.tag="new"', command)
        self.assertIn('gateway.existingSecret="gateway-only"', command)
        self.assertIn('secrets.existingSecret="runtime-only"', command)

    def test_preflight_rejects_mismatched_peer_key_and_reused_signer(self):
        encode = lambda value: base64.b64encode(value).decode()
        peer, signer = [encode(letter * 32) for letter in (b'p', b's')]
        secrets = {'operator': {'WALLET_MIGRATION_DATABASE_URL': encode(b'url')},
                   'runtime': {key: encode(b'url') for key in ('DATABASE_URL', 'INVENTORY_DATABASE_URL', 'WALLET_DATABASE_URL')},
                   'gateway': {'SESSION_SECRET': signer, 'INTERNAL_TOKEN': peer}}
        secrets['runtime'].update(GATEWAY_INTERNAL_TOKEN=peer)
        kube = SimpleNamespace(get=lambda kind, name: {'data': secrets[name]})
        upgrade.require_credentials(kube, 'operator', 'runtime', 'gateway')
        secrets['gateway']['INTERNAL_TOKEN'] = signer
        with self.assertRaises(ValueError):
            upgrade.require_credentials(kube, 'operator', 'runtime', 'gateway')
        secrets['gateway']['INTERNAL_TOKEN'] = peer
        secrets['gateway']['SESSION_SECRET'] = peer
        with self.assertRaises(ValueError):
            upgrade.require_credentials(kube, 'operator', 'runtime', 'gateway')

    def test_failed_migration_does_not_restart_old_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            args, state = self.fixture(directory)
            kube = FakeKubernetes(fail=True)
            with self.assertRaises(RuntimeError):
                upgrade.execute(kube, args, state)
            self.assertFalse(state['complete'])
            self.assertFalse(any(call[0] == 'set' for call, _ in kube.calls))
            self.assertFalse(any(call[0] == 'scale' and call[-1] != '--replicas=0' for call, _ in kube.calls))
            self.assertEqual(json.loads(args.state_file.read_text())['writers'][0]['replicas'], 2)


if __name__ == '__main__':
    unittest.main()
