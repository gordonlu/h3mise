# H3Mise Agent MCP

H3Mise includes a dependency-free local MCP bridge for Codex and other MCP clients. It talks to the existing REST API at `http://127.0.0.1:4789`, automatically obtains the local session cookie, and exposes director-level tools over stdio.

The bridge intentionally excludes paid render submission, Take selection/rejection/deletion, provider credentials, and project deletion. Use the H3Mise UI for those decisions.

## Start H3Mise

The H3Mise API server must be running before an Agent calls a tool:

```powershell
pnpm dev:server
```

## Connect Codex

From the repository root:

```powershell
codex mcp add h3mise --env H3MISE_API_URL=http://127.0.0.1:4789 -- node D:\code\h3mise\tools\h3mise-mcp.mjs
```

Alternatively, add a project-scoped `.codex/config.toml` in a trusted checkout:

```toml
[mcp_servers.h3mise]
command = "node"
args = ["tools/h3mise-mcp.mjs"]
cwd = "D:\\code\\h3mise"
default_tools_approval_mode = "writes"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.h3mise.env]
H3MISE_API_URL = "http://127.0.0.1:4789"
```

Restart Codex after changing MCP configuration. Use `/mcp` or `codex mcp list` to confirm that `h3mise` is connected.

## Tools

- `h3mise_status`, `list_projects`, `open_project`
- `get_production_overview`, `list_shots`, `inspect_shot`
- `build_context_package`, `parse_director_plan`, `apply_director_plan`
- `compile_prompt`, `create_revision_prompt`
- `review_take`, `run_preflight`, `inspect_jobs`
- `get_runninghub_config`, `set_runninghub_region`
- `configure_runninghub_video_profile`, `detect_runninghub_video_nodes`
- `configure_runninghub_storyboard_profile`, `detect_runninghub_storyboard_nodes`

`run_preflight` performs checks only. It cannot submit a render.

## RunningHub configuration

An Agent can inspect key presence, select the `cn` or `global` region, configure video and Storyboard AI App IDs and mappings, and run `apiCallDemo` node detection. Detection does not submit a paid task and results in `nodes_detected`, not `verified`.

The MCP server never accepts or returns the RunningHub API Key. Enter it directly in **Settings → Provider — RunningHub AI App**, or set `RUNNINGHUB_API_KEY` in the H3Mise server environment. Region, API Key, video AI App, and Storyboard AI App must all belong to the same RunningHub site.

