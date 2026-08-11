from pathlib import Path
from unittest.mock import Mock

from app import version


def test_git_ref_requests_at_least_eight_hex_digits(monkeypatch) -> None:
    monkeypatch.delenv("TUNEFORGE_GIT_REF", raising=False)
    run = Mock(return_value=Mock(stdout="v1.2.3-4-g12345678-dirty\n"))
    monkeypatch.setattr(version.subprocess, "run", run)
    workspace_root = Path("/workspace")

    assert version._git_ref(workspace_root) == "v1.2.3-4-g12345678-dirty"
    run.assert_called_once_with(
        ["git", "describe", "--tags", "--long", "--dirty", "--always", "--abbrev=8"],
        cwd=workspace_root,
        check=True,
        capture_output=True,
        text=True,
        timeout=2,
    )
