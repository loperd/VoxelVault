"""Plan or execute an offline Ledger ownership upgrade for an activated installation.

No opening export/import, data reset or old-image rollback is performed. Supply every
writer deployment, including a separate workshop worker when one exists.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import time
import uuid


class Kubernetes:
    def __init__(self, context, namespace):
        self.prefix = ['kubectl', '--context', context, '-n', namespace]

    def run(self, *args, document=None, timeout=60):
        result = subprocess.run(self.prefix + list(args), input=None if document is None else json.dumps(document),
                                capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f'kubectl {args[0]} failed: {result.stderr.strip()}')
        return result.stdout

    def get(self, kind, name):
        return json.loads(self.run('get', kind, name, '-o', 'json'))

    def upgrade_chart(self, args, replicas=0):
        repository, tag = args.image.rsplit(':', 1)
        gateway_repository, gateway_tag = args.gateway_image.rsplit(':', 1)
        command = ['helm', 'upgrade', args.helm_release, str(args.chart),
                   '--kube-context', args.context, '--namespace', args.namespace]
        for values in args.helm_values:
            command += ['-f', str(values)]
        for key, value in {'image.repository': repository, 'image.tag': tag,
                           'gateway.image.repository': gateway_repository, 'gateway.image.tag': gateway_tag,
                           'gateway.existingSecret': args.gateway_secret,
                           'secrets.existingSecret': args.runtime_secret}.items():
            command += ['--set-json', key + '=' + json.dumps(value)]
        # Keep API writers stopped while replacing credential wiring and gateway.
        # Never --atomic: a failed rollback could revive an old schema writer.
        command += ['--set-json', 'replicaCount=' + str(replicas)]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=args.timeout + 30)


def inspect_writers(kube, writers, release=None):
    result = []
    for writer in writers:
        parts = writer.split('/')
        if len(parts) != 2 or not all(parts):
            raise ValueError('--writer must be deployment/container')
        name, container = parts
        if any(item['deployment'] == name for item in result):
            raise ValueError('list each writer deployment once')
        deployment = kube.get('deployment', name)
        if not result and release is not None and deployment.get('metadata', {}).get('annotations', {}).get('meta.helm.sh/release-name') != release:
            raise ValueError('the first writer must be the API deployment owned by the requested Helm release')
        spec = deployment['spec']
        selector = spec['selector']
        if selector.get('matchExpressions') or not selector.get('matchLabels'):
            raise ValueError('writer needs an explicit matchLabels selector')
        selected = [item for item in spec['template']['spec']['containers'] if item['name'] == container]
        if len(selected) != 1:
            raise ValueError(f'container {container} is absent from deployment {name}')
        result.append({'deployment': name, 'container': container, 'oldImage': selected[0]['image'],
                       'replicas': spec.get('replicas', 1),
                       'selector': ','.join(f'{key}={value}' for key, value in sorted(selector['matchLabels'].items()))})
    return result


def require_credentials(kube, operator_secret, runtime_secret, gateway_secret):
    operator = kube.get('secret', operator_secret).get('data', {})
    runtime = kube.get('secret', runtime_secret).get('data', {})
    if not operator.get('WALLET_MIGRATION_DATABASE_URL'):
        raise ValueError('operator Secret requires WALLET_MIGRATION_DATABASE_URL')
    for key in ('DATABASE_URL', 'INVENTORY_DATABASE_URL', 'WALLET_DATABASE_URL',
                'GATEWAY_INTERNAL_TOKEN', 'IDENTITY_INTERNAL_TOKEN'):
        if not runtime.get(key):
            raise ValueError(f'runtime Secret requires {key}')
    peer = base64.b64decode(runtime['GATEWAY_INTERNAL_TOKEN'], validate=True)
    identity = base64.b64decode(runtime['IDENTITY_INTERNAL_TOKEN'], validate=True)
    gateway = kube.get('secret', gateway_secret).get('data', {})
    for key in ('SESSION_SECRET', 'INTERNAL_TOKEN', 'IDENTITY_INTERNAL_TOKEN'):
        if not gateway.get(key):
            raise ValueError(f'gateway Secret requires {key}')
    if base64.b64decode(gateway['INTERNAL_TOKEN'], validate=True) != peer or base64.b64decode(gateway['IDENTITY_INTERNAL_TOKEN'], validate=True) != identity:
        raise ValueError('gateway and API transport credentials do not match')
    signer = base64.b64decode(gateway['SESSION_SECRET'], validate=True)
    if len(signer) < 32 or signer in (peer, identity):
        raise ValueError('gateway signer must be independent of both transport credentials')
    if len(peer) < 32 or len(identity) < 32 or peer == identity:
        raise ValueError('runtime peer and identity credentials must be distinct and at least 32 bytes')


def upgrade_job(args, state):
    security = {'runAsNonRoot': True, 'runAsUser': 65532, 'runAsGroup': 65532,
                'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                'capabilities': {'drop': ['ALL']}}

    def env(name, secret, key):
        return {'name': name, 'valueFrom': {'secretKeyRef': {'name': secret, 'key': key}}}

    def container(name, command, environment):
        return {'name': name, 'image': args.image, 'command': command, 'env': environment,
                'securityContext': security}

    operator_env = [env('WALLET_DATABASE_URL', args.operator_secret, 'WALLET_MIGRATION_DATABASE_URL')]
    check_env = [env('LEGACY_DATABASE_URL', args.runtime_secret, 'DATABASE_URL'),
                 env('INVENTORY_DATABASE_URL', args.runtime_secret, 'INVENTORY_DATABASE_URL'),
                 env('WALLET_DATABASE_URL', args.runtime_secret, 'WALLET_DATABASE_URL')]
    check = container('check-runtime', ['/economy-cutover', '-action', 'check'], check_env)
    check['envFrom'] = [{'configMapRef': {'name': args.configmap}}]
    pod = {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
           'securityContext': {'seccompProfile': {'type': 'RuntimeDefault'}},
           'initContainers': [container('migrate-ledger', ['/wallet-migrate'], operator_env),
                              container('runtime-grants', ['/runtime-grants', '-context', 'wallet',
                                                           '-role', args.runtime_role], operator_env)],
           'containers': [check]}
    if args.image_pull_secret:
        pod['imagePullSecrets'] = [{'name': args.image_pull_secret}]
    return {'apiVersion': 'batch/v1', 'kind': 'Job',
            'metadata': {'name': f"ledger-upgrade-{state['id']}-{state['attempt']}", 'namespace': args.namespace},
            'spec': {'backoffLimit': 0, 'activeDeadlineSeconds': args.timeout,
                     'template': {'spec': pod}}}


def save_state(path, state):
    # State contains resource names and image/replica information, never secret values.
    temporary = path.with_name(path.name + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(state, output, indent=2)
        output.write('\n')
    temporary.replace(path)


def execute(kube, args, state):
    state['attempt'] += 1
    save_state(args.state_file, state)
    for writer in state['writers']:
        kube.run('scale', 'deployment/' + writer['deployment'], '--replicas=0')
    # Wait for actual pod deletion, including termination, before touching the schema.
    deadline = time.monotonic() + args.timeout
    for writer in state['writers']:
        while json.loads(kube.run('get', 'pods', '-l', writer['selector'], '-o', 'json')).get('items'):
            if time.monotonic() >= deadline:
                raise RuntimeError('writers have not drained; no migration was started')
            time.sleep(1)
    job = upgrade_job(args, state)
    kube.run('create', '-f', '-', document=job)
    kube.run('wait', '--for=condition=complete', 'job/' + job['metadata']['name'],
             '--timeout=' + str(args.timeout) + 's', timeout=args.timeout + 30)
    # Replace API secret selection and the matching gateway before restoring writers.
    kube.upgrade_chart(args)
    # Select only the new image before restoring any replicas. Never revive an old writer.
    for writer in state['writers']:
        kube.run('set', 'image', 'deployment/' + writer['deployment'], writer['container'] + '=' + args.image)
    for writer in state['writers']:
        kube.run('scale', 'deployment/' + writer['deployment'], '--replicas=' + str(writer['replicas']))
    # Persist the original API replica count in Helm as well as the Deployment.
    kube.upgrade_chart(args, replicas=state['writers'][0]['replicas'])
    for writer in state['writers']:
        kube.run('rollout', 'status', 'deployment/' + writer['deployment'],
                 '--timeout=' + str(args.timeout) + 's', timeout=args.timeout + 30)
    kube.run('rollout', 'status', 'deployment/' + state['writers'][0]['deployment'] + '-gateway',
             '--timeout=' + str(args.timeout) + 's', timeout=args.timeout + 30)
    state['complete'] = True
    save_state(args.state_file, state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True)
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--image', required=True, help='New Ledger-compatible API/worker image')
    parser.add_argument('--gateway-image', required=True, help='Gateway image built with the pinned identity-token patch')
    parser.add_argument('--gateway-secret', required=True)
    parser.add_argument('--helm-release', required=True)
    parser.add_argument('--helm-values', type=Path, action='append', required=True)
    parser.add_argument('--chart', type=Path, default=Path(__file__).parent / 'helm/voxel-vault')
    parser.add_argument('--writer', action='append', required=True, help='deployment/container; repeat for every writer')
    parser.add_argument('--runtime-role', required=True)
    parser.add_argument('--operator-secret', required=True)
    parser.add_argument('--runtime-secret', required=True)
    parser.add_argument('--configmap', required=True)
    parser.add_argument('--image-pull-secret')
    parser.add_argument('--state-file', type=Path, required=True)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--execute', action='store_true', help='Without this flag, print the plan without changing the cluster')
    args = parser.parse_args()
    if args.timeout <= 0 or any(':' not in image.rsplit('/', 1)[-1] or image.endswith(':latest') or ',' in image for image in (args.image, args.gateway_image)):
        parser.error('use a positive timeout and an explicitly versioned new image')
    if any(not path.is_file() for path in args.helm_values) or not args.chart.is_dir():
        parser.error('chart and all Helm values files must exist')
    if len({args.operator_secret, args.runtime_secret, args.gateway_secret}) != 3:
        parser.error('operator, gateway and API Secrets must differ')
    kube = Kubernetes(args.context, args.namespace)
    binding = {'context': args.context, 'namespace': args.namespace, 'image': args.image,
               'requestedWriters': args.writer, 'role': args.runtime_role,
               'operatorSecret': args.operator_secret, 'runtimeSecret': args.runtime_secret,
               'configMap': args.configmap, 'imagePullSecret': args.image_pull_secret,
               'gatewayImage': args.gateway_image, 'gatewaySecret': args.gateway_secret,
               'helmRelease': args.helm_release, 'chart': str(args.chart.resolve()),
               'helmValues': [str(path.resolve()) for path in args.helm_values]}
    if args.state_file.exists():
        state = json.loads(args.state_file.read_text())
        if state['binding'] != binding:
            raise ValueError('state file belongs to a different upgrade')
    else:
        state = {'id': uuid.uuid4().hex[:12], 'attempt': 0, 'complete': False,
                 'binding': binding, 'writers': inspect_writers(kube, args.writer, args.helm_release)}
    require_credentials(kube, args.operator_secret, args.runtime_secret, args.gateway_secret)
    if state['complete']:
        print('This upgrade already completed; no changes made.')
        return
    if not args.execute:
        print(json.dumps({'writers': state['writers'], 'newImage': args.image,
                          'job': upgrade_job(args, {**state, 'attempt': state['attempt'] + 1}),
                          'helmRelease': args.helm_release, 'gatewayImage': args.gateway_image,
                          'helmValues': [str(path) for path in args.helm_values]}, indent=2))
        return
    try:
        execute(kube, args, state)
    except Exception:
        print('Upgrade stopped. Existing writers are not automatically restored; keep the state file and fix the failure before resuming.')
        raise
    print('Ledger migration, grants, runtime readiness and new writer rollouts completed.')


if __name__ == '__main__':
    main()
