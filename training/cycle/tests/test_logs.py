import logging
import logging.handlers
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from zapcycle import logs, proc


class LogsTest(unittest.TestCase):
    def test_rotation_settings(self):
        d = Path(tempfile.mkdtemp())
        log = logs.setup_logging(d, quiet=True)
        h = [x for x in log.handlers if isinstance(x, logging.handlers.RotatingFileHandler)][0]
        self.assertEqual((h.maxBytes, h.backupCount), (10 * 1024 * 1024, 5))
        self.assertEqual(Path(h.baseFilename), d / "cycle.log")

    def test_rotation_happens(self):
        d = Path(tempfile.mkdtemp())
        log = logs.setup_logging(d, quiet=True)
        h = [x for x in log.handlers if isinstance(x, logging.handlers.RotatingFileHandler)][0]
        h.maxBytes = 2000
        for i in range(400):
            log.info(f"line {i} " + "x" * 50)
        names = sorted(p.name for p in d.iterdir())
        self.assertEqual(names, ["cycle.log", "cycle.log.1", "cycle.log.2", "cycle.log.3", "cycle.log.4", "cycle.log.5"])

    def test_secrets_never_reach_the_log(self):
        d = Path(tempfile.mkdtemp())
        with mock.patch.dict(os.environ, {"R2_PUBLISH_SECRET_ACCESS_KEY": "s3cr3t-value-123", "MINIO_ROOT_PASSWORD": "pw-local-999"}):
            log = logs.setup_logging(d, quiet=True)
            log.error("failed with s3cr3t-value-123 and pw-local-999 in the text")
            for h in log.handlers:
                h.flush()
            text = (d / "cycle.log").read_text()
            self.assertNotIn("s3cr3t-value-123", text)
            self.assertNotIn("pw-local-999", text)
            self.assertIn("***", text)

    def test_subprocesses_get_no_credentials(self):
        with mock.patch.dict(os.environ, {"R2_EVENTS_SECRET_ACCESS_KEY": "abcd1234", "MINIO_ROOT_USER": "u", "GITHUB_RELEASES_TOKEN": "tok-1234", "AWS_SECRET_ACCESS_KEY": "aws-123", "PATH": os.environ.get("PATH", "")}):
            env = proc.child_env({"ZAP_FACTS": "x"})
        for k in ("R2_EVENTS_SECRET_ACCESS_KEY", "MINIO_ROOT_USER", "GITHUB_RELEASES_TOKEN", "AWS_SECRET_ACCESS_KEY"):
            self.assertNotIn(k, env)
        self.assertEqual(env["ZAP_FACTS"], "x")
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")

    def test_run_log_keeps_output_and_redacts(self):
        d = Path(tempfile.mkdtemp())
        with mock.patch.dict(os.environ, {"MINIO_ROOT_PASSWORD": "visible-secret-42"}):
            out = proc.run(["sh", "-c", "echo out-line; echo err-line >&2; echo visible-secret-42"], d / "run.log")
            self.assertIn("out-line", out)
            text = (d / "run.log").read_text()
        self.assertIn("err-line", text)
        self.assertNotIn("visible-secret-42", text)

    def test_run_failure_and_deadline(self):
        import time

        d = Path(tempfile.mkdtemp())
        with self.assertRaisesRegex(Exception, "exit code 3"):
            proc.run(["sh", "-c", "exit 3"], d / "run.log")
        t0 = time.time()
        with self.assertRaisesRegex(Exception, "time limit"):
            proc.run(["sleep", "30"], d / "run.log", deadline=time.time() + 1.5)
        self.assertLess(time.time() - t0, 15)

    def test_prune_keeps_the_newest_20(self):
        d = Path(tempfile.mkdtemp())
        for i in range(25):
            p = logs.run_log_path(d, f"20261101-{i:04d}")
            p.write_text("x")
            os.utime(p, (1_700_000_000 + i, 1_700_000_000 + i))
        gone = logs.prune_run_logs(d)
        self.assertEqual(len(gone), 5)
        self.assertEqual(sorted(p.name for p in (d / "runs").iterdir())[0], "20261101-0005.log")

