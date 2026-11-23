"""cycle.py status prints the manifest's control share: tools/docs/record-release.ts records the
test window's share from that output (DEPLOY.md section 9.6)."""

import unittest
from datetime import datetime, timezone

from zapcycle.cli import cmd_status
from zapcycle.publish import init, publish, rollback

from .helpers import fake_cycle, temp_config
from .samples import make_candidate

T0 = int(datetime(2026, 11, 22, 12, tzinfo=timezone.utc).timestamp() * 1000)


class StatusShareTest(unittest.TestCase):
    def test_status_prints_the_control_share_in_and_out_of_a_window(self):
        cfg, _tmp = temp_config("test")
        cyc, _s3 = fake_cycle(cfg, clock=lambda: T0)
        init(cyc)
        m = cmd_status(cyc)["manifest"]
        self.assertEqual((m["current"], m["control"], m["controlShare"], m["controlUntil"]), ("v1", None, 0.3, None))
        v = cyc.next_version(cyc.require_manifest())
        make_candidate(cyc, "20261121-2200", v, "v1", passed=True)
        publish(cyc, "20261121-2200")
        m = cmd_status(cyc)["manifest"]
        self.assertEqual((m["current"], m["control"], m["controlShare"]), (v, "v1", 0.3))
        self.assertIsNotNone(m["controlUntil"])
        rollback(cyc, "v1")
        m = cmd_status(cyc)["manifest"]
        self.assertEqual((m["current"], m["control"], m["controlShare"], m["controlUntil"]), ("v1", None, 0.3, None))


if __name__ == "__main__":
    unittest.main()
