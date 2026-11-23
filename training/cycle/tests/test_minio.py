"""Against the running S3 stand-in (compose service minio, profile cycle-dev). These tests fail with
a clear message when it is down: start it with docker compose --profile cycle-dev up -d minio."""

import os
import unittest

from zapcycle.errors import GuardError
from zapcycle.storage import Store, make_client

from .helpers import MINIO_DOWN, have_minio_env, minio_up, temp_config

PREFIX = "unit-tests/"


class MinioTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not have_minio_env():
            raise AssertionError("MINIO_ROOT_USER and MINIO_ROOT_PASSWORD are not set: run the tests in the cycle service with .env")
        if not minio_up():
            raise AssertionError(MINIO_DOWN)
        cls.cfg, _ = temp_config("test")
        Store(cls.cfg, "admin").create_buckets()

    def tearDown(self):
        for role, kind in (("bridge", "events"), ("publish", "models"), ("publish", "public")):
            s = Store(self.cfg, role)
            for o in s.list(kind, PREFIX):
                s.client.delete_object(Bucket=s.buckets[kind], Key=o.key)

    def test_roles_on_a_real_server(self):
        pub = Store(self.cfg, "publish")
        etag = pub.put("models", PREFIX + "a.json", b'{"a":1}', "application/json; charset=utf-8")
        obj = pub.get("models", PREFIX + "a.json")
        self.assertEqual((obj.body, obj.etag, obj.content_type), (b'{"a":1}', etag, "application/json; charset=utf-8"))
        pub.put("public", PREFIX + "summary.json", b"{}", "application/json", "public, max-age=300")
        head = pub.client.head_object(Bucket=self.cfg.storage["public_bucket"], Key=PREFIX + "summary.json")
        self.assertEqual(head["CacheControl"], "public, max-age=300")
        ev = Store(self.cfg, "events")
        with self.assertRaises(GuardError):
            ev.put("events", PREFIX + "x.json", b"{}", "application/json")
        Store(self.cfg, "bridge").put("events", PREFIX + "m.json", b"{}", "application/json")
        self.assertEqual([o.key for o in ev.list("events", PREFIX)], [PREFIX + "m.json"])
        self.assertIsNone(ev.get("events", PREFIX + "missing.json"))
        pub.delete("models", PREFIX + "a.json")
        self.assertIsNone(pub.get("models", PREFIX + "a.json"))

    def test_listing_continues_past_1000_keys(self):
        b = Store(self.cfg, "bridge")
        for i in range(1003):
            b.client.put_object(Bucket=b.buckets["events"], Key=f"{PREFIX}many/{i:05d}", Body=b"x")
        keys = [o.key for o in Store(self.cfg, "events").list("events", PREFIX + "many/")]
        self.assertEqual(len(keys), 1003)
        self.assertEqual(keys[-1], f"{PREFIX}many/01002")

    def test_wrong_credentials_are_refused(self):
        bad = make_client(self.cfg.storage["endpoint"], os.environ["MINIO_ROOT_USER"], "not-the-password")
        with self.assertRaises(Exception) as e:
            bad.list_objects_v2(Bucket=self.cfg.storage["events_bucket"])
        self.assertEqual(e.exception.response["Error"]["Code"], "SignatureDoesNotMatch")
