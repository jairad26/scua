"""MacAgentBench whole-agent adapter for a pre-provisioned SCUA guest."""

import json
import shlex
import uuid


CORE_SCUA_TOOLS = [
    "open_root", "find_roots", "observe_ui", "search_ui", "expand_ui",
    "inspect_ui", "act_ui", "execute_plan", "wait_for",
]


class ScuaAgent:
    def __init__(
        self,
        model="scua",
        url=None,
        remote_codex="/Applications/Codex.app/Contents/Resources/codex",
        remote_scua_root="/Users/pipiwu/scua",
        task_timeout_seconds=900,
    ):
        self.model = model
        self.url = url
        self.remote_codex = remote_codex
        self.remote_scua_root = remote_scua_root
        self.task_timeout_seconds = task_timeout_seconds

    def reset(self, _logger=None):
        return None

    def _prompt(self, instruction):
        return "\n".join(
            [
                "You are the planning layer in a controlled computer-use benchmark.",
                "Complete the task using only tools from the SCUA MCP server.",
                "Do not use shell, filesystem, AppleScript, direct APIs, or any non-SCUA tool during the task.",
                "Batch independent selectors in one search_ui call and prefer one checked act_ui or execute_plan transaction.",
                "A failed mutation cannot become success through a later read-only observation.",
                "Verify the requested end state before finishing.",
                f"Task: {instruction}",
                'Final line: SCUA_BENCHMARK_RESULT {"status":"success"|"failure","summary":"brief evidence"}',
            ]
        )

    def readiness_command(self):
        run_mcp = f"{self.remote_scua_root.rstrip('/')}/scripts/run-mcp.sh"
        return f"test -x {shlex.quote(self.remote_codex)} && test -x {shlex.quote(run_mcp)}"

    def build_command(self, instruction, remote_sessions_dir=None):
        run_mcp = f"{self.remote_scua_root.rstrip('/')}/scripts/run-mcp.sh"
        args = [
            self.remote_codex,
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
            "--json",
            "-c",
            f"mcp_servers.scua.command={json.dumps(run_mcp)}",
            "-c",
            'mcp_servers.scua.default_tools_approval_mode="approve"',
            "-c",
            f"mcp_servers.scua.enabled_tools={json.dumps(CORE_SCUA_TOOLS)}",
            "-c",
            'model_reasoning_effort="low"',
            "-c",
            'model_verbosity="low"',
        ]
        if self.model and self.model != "scua":
            args.extend(["--model", self.model])
        args.append(self._prompt(instruction))
        codex_command = " ".join(shlex.quote(arg) for arg in args)
        if remote_sessions_dir:
            trajectory = f"{remote_sessions_dir}/trajectory.jsonl"
            diagnostics = f"{remote_sessions_dir}/stderr.log"
            codex_command = (
                f"mkdir -p {shlex.quote(remote_sessions_dir)} && "
                f"{codex_command} > {shlex.quote(trajectory)} 2> {shlex.quote(diagnostics)}"
            )
        return "zsh -ilc " + shlex.quote(codex_command)

    def run_task(self, env, instruction):
        stdout, stderr, status = env.run_command_with_status(self.readiness_command(), timeout=30)
        if status != 0:
            raise RuntimeError(
                "SCUA guest is not provisioned: expected executable Codex and SCUA run-mcp.sh. "
                f"stdout={stdout!r} stderr={stderr!r}"
            )
        remote_sessions_dir = f"/tmp/scua-macagentbench/{uuid.uuid4().hex}"
        command = self.build_command(instruction, remote_sessions_dir)
        stdout, stderr, status = env.run_command_with_status(
            command, timeout=self.task_timeout_seconds + 60
        )
        return {
            "command": command,
            "stdout": stdout,
            "stderr": stderr,
            "exit_status": status,
            "remote_sessions_dir": remote_sessions_dir,
        }
