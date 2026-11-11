"""Exercise staging, failure boundaries, and real Compose resolution without production data."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import deploy
from test_release import MANIFEST as RELEASE, SHA
SOURCE_ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((SOURCE_ROOT / 'scripts/deployment.json').read_text())
REPOSITORY = 'pior-labs/' + SOURCE_ROOT.name
BASE_URL = CONFIG.get('base_url') or 'https://fixture.example'

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.old_cwd = Path.cwd()
        os.chdir(self.workspace)
        self.addCleanup(os.chdir, self.old_cwd)
        Path("candidate").mkdir()
        Path("candidate/scripts").mkdir()
        shutil.copyfile(SOURCE_ROOT / "scripts/deployment.json", "candidate/scripts/deployment.json")
        for name in ("docker-compose.yml", "docker-compose.production.yml", "docker-compose.production.yml"):
            Path("candidate", name).write_text("services: {}\n")
        Path("release.json").write_text(json.dumps(RELEASE))
        self.root = self.workspace / "tasks"
        self.history = self.root / ".deployments"
        self.history.mkdir(parents=True)
        self.previous = {"sha": "d" * 40, "run_id": 100, "status": "healthy"}
        (self.history / "current.json").write_text(json.dumps(self.previous))
        self.environment = patch.dict(os.environ, {"DEPLOY_DIR": str(self.root), "CENTRAL_AUTH_CLIENT_SECRET": "fixture-client", "BETTER_AUTH_SECRET": "fixture-session-secret-at-least-32-characters", "COMPOSE_PROJECT_NAME": "tasks", "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_RUN_ID": "456", "GITHUB_STEP_SUMMARY": str(self.workspace / "summary"), "DEPLOY_BASE_URL": "https://fixture.example", "EXPECTED_SHA": SHA, "EXPECTED_RUN_ID": "123", "EXPECTED_ATTEMPT": "2"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.old_umask = os.umask(0o022)
        self.addCleanup(os.umask, self.old_umask)
        self.calls = []

    def run_command(self, *args, **kwargs):
        self.calls.append(args)
        if "config" in args:
            rendered = {"services": {service: {"image": image, "build": {"context": "."}} for service, image in RELEASE["images"].items()}, "secrets": {name: {"environment": "GITHUB_TOKEN"} for name in CONFIG['build_secrets']}}
            for service, mounts in CONFIG.get('host_data_mounts', {}).items():
                rendered['services'][service]['volumes'] = [{'type':'bind','target':target,'source':'/fixture/candidate/data'} for target in mounts]
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(rendered))
        return subprocess.CompletedProcess(args, 0, stdout="{}")

    def test_success_uses_only_digests_and_records_after_readiness(self):
        with patch.object(deploy, "command", side_effect=self.run_command):
            deploy.deploy()
        current = json.loads((self.history / "current.json").read_text())
        self.assertEqual(current["sha"], SHA)
        self.assertEqual(current["status"], "healthy")
        self.assertEqual(json.loads((self.history / "previous.json").read_text()), self.previous)
        runtime = Path(current["runtime_dir"])
        rendered = json.loads((runtime / "compose.json").read_text())
        self.assertTrue(all("build" not in service for service in rendered["services"].values()))
        self.assertTrue(all(name not in rendered['secrets'] for name in CONFIG['build_secrets']))
        self.assertEqual((runtime / ".env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / "current").resolve(), runtime)
        self.assertTrue((runtime / CONFIG["compose_files"][0]).exists())
        commands = [list(args) for args in self.calls]
        migration = next(args for args in commands if "run" in args)
        startup = next(args for args in commands if "up" in args)
        self.assertNotIn("--build", migration)
        self.assertTrue(all(service["pull_policy"] == "never" for service in rendered["services"].values()))
        self.assertIn("--no-deps", migration)
        self.assertIn("--no-build", startup)
        self.assertIn("--wait", startup)
        self.assertEqual([args[-1] for args in commands if args[0] == "curl"], [BASE_URL.rstrip("/") + path for path in CONFIG["health_paths"]] + ([CONFIG["discovery"]["url"]] if CONFIG.get("discovery") else []))

    def test_failures_preserve_successful_release_and_do_not_auto_rollback(self):
        for failing_phase in ("pull", "run", "up", "curl"):
            self.calls = []
            def fail(*args, **kwargs):
                if failing_phase in args:
                    raise subprocess.CalledProcessError(1, args)
                return self.run_command(*args, **kwargs)
            with self.subTest(phase=failing_phase), patch.object(deploy, "command", side_effect=fail), self.assertRaises(subprocess.CalledProcessError):
                deploy.deploy()
            self.assertEqual(json.loads((self.history / "current.json").read_text()), self.previous)
            self.assertEqual(json.loads((self.history / "attempt.json").read_text())["status"], "failed")
            self.assertFalse((self.history / "previous.json").exists())
            self.assertFalse((self.root / "current").exists())

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI is required for rendering")
    def test_real_compose_reads_candidate_environment_and_preserves_project(self):
        for name in CONFIG["compose_files"]:
            shutil.copyfile(SOURCE_ROOT / name, Path("candidate") / name)
        # Deliberately different from the staged environment: the old deployment
        # must not silently supply env_file values to the new containers.
        (self.root / ".env").write_text("SECRET=stale\n")
        secret = "fixture-'quotes\"-backslash\\-dollar$UNSET-${UNSET}-$$-unicodeé"
        real_command = deploy.command
        def render_only(*args, **kwargs):
            if "config" in args:
                return real_command(*args, **kwargs)
            return self.run_command(*args, **kwargs)
        with patch.dict(os.environ, {"CENTRAL_AUTH_CLIENT_SECRET": secret, "APP_ENV": "SECRET=ignored"}), patch.object(deploy, "command", side_effect=render_only):
            deploy.deploy()
        runtime = (self.root / "current").resolve()
        config = json.loads((runtime / "compose.json").read_text())
        self.assertEqual(config["name"], "tasks")
        self.assertEqual(config["services"]["api"]["environment"]["COMPOSE_PROJECT_NAME"], "tasks")
        self.assertEqual((runtime / ".env").read_text().count("COMPOSE_PROJECT_NAME="), 1)
        self.assertNotIn('SECRET', config['services']['api']['environment'])
        final = json.loads(real_command('docker', 'compose', '-f', str(runtime / 'compose.json'),
                                       'config', '--format', 'json', capture_output=True).stdout)
        environment = final['services']['api']['environment']
        # Compose serializes literal dollars as $$ so its output is reusable.
        self.assertEqual(environment['CENTRAL_AUTH_CLIENT_SECRET'], secret.replace('$', '$$'))
        self.assertEqual(environment, config['services']['api']['environment'])
        self.assertEqual(environment['BETTER_AUTH_SECRET'], os.environ['BETTER_AUTH_SECRET'])
        self.assertEqual(environment['DATABASE_URL'], '')
        self.assertEqual(environment['DATABASE_URL_FILE'], '/run/secrets/database_url')
        self.assertNotIn('CENTRAL_AUTH_CLIENT_SECRET', final['services']['web'].get('environment', {}))
        self.assertTrue(all("build" not in service for service in config["services"].values()))
        for service, mounts in CONFIG.get("host_data_mounts", {}).items():
            for target, relative in mounts.items():
                mount = next(v for v in config['services'][service]['volumes'] if v['target'] == target)
                self.assertEqual(mount['source'], str(self.root / relative))
        real_command("docker", "compose", "-f", str(runtime / "compose.json"), "config", "--quiet", capture_output=True)

    def test_staging_failure_is_recorded_without_touching_production(self):
        Path("candidate", CONFIG["compose_files"][0]).unlink()
        with patch.object(deploy, "command") as command, self.assertRaises(FileNotFoundError):
            deploy.deploy()
        command.assert_not_called()
        self.assertEqual(json.loads((self.history / "attempt.json").read_text())["status"], "failed")
        self.assertEqual(json.loads((self.history / "current.json").read_text()), self.previous)

    def test_project_secret_is_required_and_validated_before_writing(self):
        for value in ("", "Bad Name", "tasks\nOTHER=value", "../tasks"):
            with self.subTest(value=value), patch.dict(os.environ, {"COMPOSE_PROJECT_NAME": value}), patch.object(deploy, "command") as command, self.assertRaises(ValueError):
                deploy.deploy()
            command.assert_not_called()
        self.assertFalse((self.root / "releases").exists())

    def test_missing_or_invalid_secrets_fail_before_staging(self):
        for key, value in (('CENTRAL_AUTH_CLIENT_SECRET', ''), ('BETTER_AUTH_SECRET', ''),
                           ('BETTER_AUTH_SECRET', 'short'),
                           ('CENTRAL_AUTH_CLIENT_SECRET', 'private\nINJECTED=value'),
                           ('CENTRAL_AUTH_CLIENT_SECRET', 'replace-with-placeholder')):
            with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}), \
                    patch.object(deploy, 'command') as command, self.assertRaises(ValueError) as error:
                deploy.deploy()
            self.assertIn(key, str(error.exception))
            command.assert_not_called()
        self.assertFalse((self.root / 'releases').exists())

    def test_variables_override_defaults_without_inheriting_unrelated_environment(self):
        with patch.dict(os.environ, {'PUBLIC_BASE_URL': 'https://override.example', 'UNRELATED': 'private'}):
            value = deploy.production_environment('tasks')
        self.assertIn('PUBLIC_BASE_URL="https://override.example"', value)
        self.assertIn('CENTRAL_AUTH_CLIENT_ID="tasks"', value)
        self.assertNotIn('UNRELATED', value)

    def test_rejects_broad_directory_before_writing(self):
        with patch.dict(os.environ, {"DEPLOY_DIR": "/opt/docker"}), self.assertRaises(ValueError):
            deploy.deploy()


if __name__ == "__main__":
    unittest.main()
