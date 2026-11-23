import unittest
from unittest import mock

from zapcycle import storage
from zapcycle.errors import CycleError, GuardError
from zapcycle.storage import Store

from .helpers import MINIO_ENV, R2_ENV, FakeS3, temp_config


def no_network(*a, **k):
    raise AssertionError("a client was created although a guard should refuse first")


class GuardTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(storage, "make_client", side_effect=no_network)
        p.start()
        self.addCleanup(p.stop)

    def refuse(self, cfg, role, env, pattern):
        with self.assertRaisesRegex(GuardError, pattern):
            Store(cfg, role, env=env)

    def test_r2_refuses_test_buckets(self):
        cfg, _ = temp_config("prod", storage={"events_bucket": "zap-test-events"})
        self.refuse(cfg, "events", R2_ENV, "zap-events")

    def test_minio_refuses_production_buckets(self):
        cfg, _ = temp_config("test", storage={"models_bucket": "zap-models"})
        self.refuse(cfg, "publish", MINIO_ENV, "zap-test-")

    def test_minio_refuses_a_remote_endpoint(self):
        cfg, _ = temp_config("test", storage={"endpoint": R2_ENV["R2_ENDPOINT"]})
        self.refuse(cfg, "events", MINIO_ENV, "local endpoint")
        cfg, _ = temp_config("test", storage={"endpoint": "http://minio.example.com:9000"})
        self.refuse(cfg, "events", MINIO_ENV, "local endpoint")

    def test_r2_needs_an_r2_endpoint_from_the_environment(self):
        cfg, _ = temp_config("prod")
        self.refuse(cfg, "events", {**R2_ENV, "R2_ENDPOINT": "http://minio:9000"}, "R2_ENDPOINT")
        self.refuse(cfg, "events", {k: v for k, v in R2_ENV.items() if k != "R2_ENDPOINT"}, "R2_ENDPOINT")
        self.refuse(cfg, "events", {**R2_ENV, "R2_ENDPOINT": "https://example.com"}, "R2_ENDPOINT")
        cfg2, _ = temp_config("prod", storage={"endpoint": "http://minio:9000"})
        self.refuse(cfg2, "events", R2_ENV, "not from the config")

    def test_minio_only_roles(self):
        cfg, _ = temp_config("prod")
        self.refuse(cfg, "bridge", R2_ENV, "minio mode")
        self.refuse(cfg, "admin", R2_ENV, "minio mode")
        self.refuse(cfg, "root", R2_ENV, "unknown")

    def test_r2_roles_use_their_own_tokens(self):
        seen = []
        with mock.patch.object(storage, "make_client", side_effect=lambda e, k, s: seen.append((e, k, s)) or FakeS3()):
            cfg, _ = temp_config("prod")
            Store(cfg, "events", env=R2_ENV)
            Store(cfg, "publish", env=R2_ENV)
        self.assertEqual(seen[0], (R2_ENV["R2_ENDPOINT"], "events-key-id", "events-secret-value"))
        self.assertEqual(seen[1], (R2_ENV["R2_ENDPOINT"], "publish-key-id", "publish-secret-value"))

    def test_missing_credentials(self):
        cfg, _ = temp_config("prod")
        with self.assertRaisesRegex(CycleError, "R2_PUBLISH_ACCESS_KEY_ID"):
            Store(cfg, "publish", env={"R2_ENDPOINT": R2_ENV["R2_ENDPOINT"]})

    def test_roles_reach_only_their_buckets(self):
        cfg, _ = temp_config("prod")
        s3 = FakeS3({"zap-events": {}, "zap-models": {}, "zap-public": {}})
        ev = Store(cfg, "events", env=R2_ENV, client=s3)
        pub = Store(cfg, "publish", env=R2_ENV, client=s3)
        ev.list("events", "matches/")
        for call in (lambda: ev.put("events", "x", b"", "text/plain"), lambda: ev.get("models", "manifest.json"), lambda: ev.delete("events", "x"), lambda: pub.get("events", "matches/x"), lambda: pub.list("events", ""), lambda: pub.create_buckets(), lambda: pub.list_buckets()):
            with self.assertRaises(GuardError):
                call()
        pub.put("models", "manifest.json", b"{}", "application/json")
        pub.put("public", "summary.json", b"{}", "application/json")
        self.assertEqual([c for c in s3.calls if c[0] == "put"], [("put", "zap-models", "manifest.json"), ("put", "zap-public", "summary.json")])
        self.assertFalse(any(c[1] == "zap-events" and c[0] != "list" for c in s3.calls))

    def test_too_large_objects_are_refused(self):
        cfg, _ = temp_config("test")
        s3 = FakeS3({"zap-test-unit-events": {}, "zap-test-unit-models": {}, "zap-test-unit-public": {}})
        s3.put_object("zap-test-unit-events", "matches/v1/big.json", b"x" * 300, "application/json")
        ev = Store(cfg, "events", env=MINIO_ENV, client=s3)
        with self.assertRaises(storage.TooLarge):
            ev.get("events", "matches/v1/big.json", max_bytes=200)
        self.assertIsNone(ev.get("events", "missing.json"))
