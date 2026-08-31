#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env GDBENCH_TASK_COLLECTION=tasks "$SCRIPT_DIR/open_gdbench_case.sh" task_0015
