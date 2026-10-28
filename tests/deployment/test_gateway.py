"""Verify the rendered public edge and private backend boundary without a cluster."""
import pathlib
import json
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHART = ROOT / "deploy/helm/voxel-vault"


def render(*args):
    result = subprocess.run(
        ["helm", "template", "voxel-vault", str(CHART), *args],
        check=True, capture_output=True, text=True,
    )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def resource(docs, kind, suffix):
    return next(doc for doc in docs if doc["kind"] == kind and doc["metadata"]["name"].endswith(suffix))


class GatewayBoundary(unittest.TestCase):
    def test_every_environment_routes_ingress_only_to_gateway(self):
        for environment in ("local", "prod"):
            with self.subTest(environment=environment):
                docs = render("-f", str(CHART / f"values.{environment}.yaml"))
                ingress = resource(docs, "Ingress", "voxel-vault")
                paths = ingress["spec"]["rules"][0]["http"]["paths"]
                self.assertTrue(paths)
                self.assertTrue(all(path["backend"]["service"]["name"].endswith("-gateway") for path in paths))
                backend = resource(docs, "Service", "voxel-vault")
                self.assertEqual(backend["spec"]["type"], "ClusterIP")
                gateway = resource(docs, "Deployment", "-gateway")
                self.assertNotEqual(backend["spec"]["selector"], gateway["spec"]["template"]["metadata"]["labels"])
                policy = resource(docs, "NetworkPolicy", "-backend")["spec"]
                self.assertEqual(policy["podSelector"]["matchLabels"], backend["spec"]["selector"])
                self.assertEqual(policy["policyTypes"], ["Ingress"])
                sources = policy["ingress"][0]["from"]
                self.assertEqual(sources, [{"podSelector": {"matchLabels": gateway["spec"]["template"]["metadata"]["labels"]}}])

    def test_gateway_receives_only_its_credentials_and_exposes_no_internal_routes(self):
        docs = render()
        container = resource(docs, "Deployment", "-gateway")["spec"]["template"]["spec"]["containers"][0]
        self.assertNotIn("envFrom", container)
        references = [entry["valueFrom"]["secretKeyRef"] for entry in container["env"] if "valueFrom" in entry]
        self.assertEqual({entry["key"] for entry in references}, {"SESSION_SECRET", "INTERNAL_TOKEN", "TG_OIDC_CLIENT_SECRET"})
        self.assertEqual({entry["name"] for entry in references}, {"voxel-vault-gateway-secrets"})
        config = yaml.safe_load(resource(docs, "ConfigMap", "-gateway")["data"]["gateway.yaml"])
        self.assertEqual({route["pattern"] for route in config["routes"]}, {"/api/v1/", "GET /api/v1/cases", "GET /api/v1/cases/{caseID}/catalog", "GET /api/v1/items/{itemID}/image.svg", "GET /readyz"})
        self.assertEqual({route["pattern"] for route in config["routes"] if route.get("public")} , {"GET /api/v1/cases", "GET /api/v1/cases/{caseID}/catalog", "GET /api/v1/items/{itemID}/image.svg", "GET /readyz"})
        self.assertTrue(config["plugins"]["telegramAuth"])
        self.assertEqual(config["telegramAuth"]["mode"], "oidc")

    def test_public_backend_service_is_rejected(self):
        with self.assertRaises(subprocess.CalledProcessError):
            render("--set", "service.type=LoadBalancer")

    def test_api_receives_only_its_explicit_context_credentials(self):
        for environment in (None, "local", "prod"):
            args = [] if environment is None else ["-f", str(CHART / f"values.{environment}.yaml")]
            docs = render(*args)
            api = resource(docs, "Deployment", "voxel-vault")["spec"]["template"]["spec"]["containers"][0]
            self.assertTrue(all("secretRef" not in item for item in api.get("envFrom", [])))
            references = {item["name"]: item["valueFrom"]["secretKeyRef"] for item in api["env"]}
            self.assertEqual(set(references), {"DATABASE_URL", "INVENTORY_DATABASE_URL", "WALLET_DATABASE_URL", "IDENTITY_DATABASE_URL", "SECURITY_DATABASE_URL", "GATEWAY_INTERNAL_TOKEN"})
            self.assertEqual({item["name"] for item in references.values()}, {"voxel-vault-secrets"})

    def test_insecure_edge_configurations_are_rejected(self):
        for args in (["--set", "gateway.enabled=false,ingress.enabled=true"],
                     ["--set", "gateway.enabled=false,service.type=LoadBalancer"],
                     ["--set", "gateway.networkPolicy.enabled=false"],
                     ["--set", "gateway.existingSecret=voxel-vault-secrets"]):
            with self.assertRaises(subprocess.CalledProcessError):
                render(*args)

    def test_gateway_configuration_remains_data_driven(self):
        docs = render("--set", "gateway.config.plugins.telegramAuth=true")
        config = yaml.safe_load(resource(docs, "ConfigMap", "-gateway")["data"]["gateway.yaml"])
        self.assertTrue(config["plugins"]["telegramAuth"])


if __name__ == "__main__":
    unittest.main()
