import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("traffic_builder", Path(__file__).with_name("build-traffic-service.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class TrafficPackageTests(unittest.TestCase):
    def test_component_hashes_reject_missing_and_modified_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                builder.validate_components(root)
            expected = {}
            for name in builder.COMPONENT_HASHES:
                (root / name).write_bytes(b"fixture")
                expected[name] = builder.sha256(root / name)
            with patch.object(builder, "COMPONENT_HASHES", expected):
                builder.validate_components(root)
                (root / "WinDivert64.sys").write_bytes(b"changed")
                with self.assertRaises(ValueError):
                    builder.validate_components(root)

    def test_build_artifacts_keep_only_executable_targets(self):
        events = [
            {"reason": "compiler-artifact", "target": {"name": "codey-traffic-service", "kind": ["bin"]}, "profile": {"test": False}, "executable": "service.exe"},
            {"reason": "compiler-artifact", "target": {"name": "codey_traffic_service", "kind": ["lib"]}, "profile": {"test": True}, "executable": "tests.exe"},
            {"reason": "compiler-artifact", "target": {"name": "unrelated"}, "executable": None},
            {"reason": "build-finished", "success": True},
        ]
        result = builder.artifacts("diagnostic\n" + "\n".join(map(json.dumps, events)))
        self.assertEqual(result, {"codey-traffic-service": Path("service.exe"), "unit-tests": Path("tests.exe")})
        desktop = {"reason": "compiler-artifact", "target": {"name": "codey_lib", "kind": ["rlib"]}, "profile": {"test": True}, "executable": "desktop-tests.exe"}
        self.assertEqual(builder.artifacts(json.dumps(desktop)), {"unit-tests": Path("desktop-tests.exe")})

    def test_source_overlay_contains_launch_integration_and_no_private_data(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(len(builder.SOURCE_FILES), len(set(builder.SOURCE_FILES)))
        for name in builder.SOURCE_FILES:
            self.assertFalse(Path(name).is_absolute())
            self.assertNotIn("..", Path(name).parts)
            self.assertTrue((root / name).is_file(), name)
            self.assertIn(Path(name).suffix, {".rs", ".toml", ".lock", ".md", ".py", ".ps1", ".ts", ".tsx", ".mjs"})
        self.assertIn("backend/src/network_proxy/process_capture.rs", builder.SOURCE_FILES)
        self.assertIn("backend/src/launcher/windows_packaged.rs", builder.SOURCE_FILES)
        self.assertIn("src/features/network-proxy/ProcessProxySelection.tsx", builder.SOURCE_FILES)

    def test_failed_build_is_not_packaged_and_commands_have_a_deadline(self):
        with patch.object(builder.subprocess, "run", return_value=subprocess.CompletedProcess(["cargo"], 1, "", "")) as command:
            with self.assertRaises(RuntimeError):
                builder.run(["cargo", "build"], Path("."), {}, timeout=12)
            self.assertEqual(command.call_args.kwargs["timeout"], 12)
            self.assertFalse(command.call_args.kwargs.get("shell", False))


if __name__ == "__main__":
    unittest.main()
