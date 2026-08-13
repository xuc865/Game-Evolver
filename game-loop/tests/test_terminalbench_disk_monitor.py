from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.monitor_terminalbench_disk import removable_containers


class TerminalBenchDiskMonitorTests(unittest.TestCase):
    @patch("scripts.monitor_terminalbench_disk.container_ids", return_value=["abc", "live"])
    @patch("scripts.monitor_terminalbench_disk.run")
    def test_only_removes_stopped_owned_private_task_containers(self, run, _ids):
        run.side_effect = lambda command, **kwargs: type("Result", (), {
            "stdout": (
            '[{"Name":"/private_task__abc__env-main-1","State":{"Running":false},"Config":{"Labels":{"com.docker.compose.project":"private_task__abc__env",'
            '"com.docker.compose.project.working_dir":"'
            + str(Path.cwd() / "experiments" / "general-baseline-runs" / "run")
            + '"}}}]'
            if command[-1] == "abc" else
            '[{"Name":"/private_task__live__env-main-1","State":{"Running":true},"Config":{"Labels":{"com.docker.compose.project":"private_task__live__env",'
            '"com.docker.compose.project.working_dir":"/Users/example/my-project"}}}]'
            if command[-1] == "live" else
            '{}'
            ),
            "returncode": 0,
        })()
        self.assertEqual(removable_containers(), ["private_task__abc__env-main-1"])

    @patch("scripts.monitor_terminalbench_disk.container_ids", return_value=["abc"])
    @patch("scripts.monitor_terminalbench_disk.run")
    def test_preserves_private_container_outside_baseline_runs(self, run, _ids):
        run.return_value.stdout = (
            '[{"Name":"/private_task__abc__env-main-1","State":{"Running":false},"Config":{"Labels":{"com.docker.compose.project":"private_task__abc__env",'
            '"com.docker.compose.project.working_dir":"/Users/example/my-project"}}}]'
        )
        self.assertEqual(removable_containers(), [])
