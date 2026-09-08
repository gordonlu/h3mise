#!/usr/bin/env node

// Minimal dependency-free MCP stdio bridge for the local H3Mise REST API.
// Keep paid submission, deletion, and Take selection out of this bridge: those
// decisions remain explicit in the H3Mise UI.

import { createInterface } from 'node:readline';

const API_BASE = (process.env.H3MISE_API_URL ?? 'http://127.0.0.1:4789').replace(/\/$/, '');
let sessionCookie = '';

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const stringProp = (description) => ({ type: 'string', description });

const tools = [
  {
    name: 'h3mise_status',
    description: 'Check the local H3Mise server and return the currently open project.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_projects',
    description: 'List local H3Mise projects with Shot and selected-Take counts.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'open_project',
    description: 'Open one existing H3Mise project. Refuses to switch away from another open project unless force is true.',
    inputSchema: objectSchema({
      projectId: stringProp('Exact project ID returned by list_projects.'),
      force: { type: 'boolean', description: 'Allow switching away from the currently open project. Defaults to false.' },
    }, ['projectId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_production_overview',
    description: 'Read the current project production overview and recommended next actions.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_shots',
    description: 'List Shots in the currently open project.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'inspect_shot',
    description: 'Read one Shot and its plans, prompts, bindings, Takes, jobs, and Preflight history.',
    inputSchema: objectSchema({ shotId: stringProp('Exact Shot ID returned by list_shots.') }, ['shotId']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'build_context_package',
    description: 'Build the canonical H3Mise Context Package for an external director Agent. This does not call an AI provider or render.',
    inputSchema: objectSchema({
      shotId: stringProp('Shot to analyze or plan.'),
      task: stringProp('Concrete director task for the receiving Agent.'),
    }, ['shotId', 'task']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'parse_director_plan',
    description: 'Validate YAML or JSON DirectorPlan text without saving it.',
    inputSchema: objectSchema({
      shotId: stringProp('Shot that the proposed plan belongs to.'),
      text: stringProp('DirectorPlan as YAML or JSON.'),
    }, ['shotId', 'text']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'apply_director_plan',
    description: 'Persist a complete DirectorPlan as a new immutable external_ai version. Never overwrites an earlier plan.',
    inputSchema: objectSchema({
      shotId: stringProp('Shot that receives the new plan version.'),
      plan: { type: 'object', description: 'Validated DirectorPlan object.', additionalProperties: true },
    }, ['shotId', 'plan']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'compile_prompt',
    description: 'Compile and persist a new deterministic H3 prompt version from the current canonical Shot state.',
    inputSchema: objectSchema({
      shotId: stringProp('Shot to compile.'),
      mode: { type: 'string', enum: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'], description: 'Optional H3 generation mode.' },
      durationSeconds: { type: 'number', exclusiveMinimum: 0, description: 'Optional requested duration.' },
    }, ['shotId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'create_revision_prompt',
    description: 'Persist a new manual PromptVersion linked to the source Take and its observed problem. Does not render or select anything.',
    inputSchema: objectSchema({
      shotId: stringProp('Shot that owns both the source Take and new prompt.'),
      text: stringProp('Complete revised prompt text.'),
      mode: { type: 'string', enum: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] },
      sourceTakeId: stringProp('Take whose observed problem motivated this revision.'),
      revisionReason: stringProp('Concrete observed problem this revision addresses.'),
      preservedAspects: { type: 'array', items: { type: 'string' }, description: 'Aspects that must remain unchanged.' },
    }, ['shotId', 'text', 'mode', 'sourceTakeId', 'revisionReason', 'preservedAspects']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'review_take',
    description: 'Record the director review for a Take. Picture and audio are separate gates; this does not select, reject, delete, or render.',
    inputSchema: objectSchema({
      takeId: stringProp('Take to review.'),
      pictureVerdict: { type: 'string', enum: ['unreviewed', 'usable', 'partial', 'unusable'] },
      audioVerdict: { type: 'string', enum: ['unreviewed', 'usable', 'partial', 'unusable'] },
      usableRanges: {
        type: 'array',
        items: objectSchema({
          start: { type: 'number', minimum: 0 },
          end: { type: 'number', exclusiveMinimum: 0 },
          media: { type: 'string', enum: ['picture', 'audio'] },
          note: { type: 'string' },
        }, ['start', 'end', 'media']),
      },
      changeRequest: stringProp('What must change in the next candidate.'),
      preservedAspects: { type: 'array', items: { type: 'string' } },
      iterationOutcome: { type: 'string', enum: ['unreviewed', 'improved', 'same', 'worse'] },
      notes: { type: 'string', description: 'Optional general Take notes.' },
    }, ['takeId', 'pictureVerdict', 'audioVerdict', 'usableRanges', 'changeRequest', 'preservedAspects', 'iterationOutcome']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run_preflight',
    description: 'Run and persist deterministic checks for one exact prompt/provider combination. This never submits a render.',
    inputSchema: objectSchema({
      shotId: stringProp('Shot to check.'),
      promptVersionId: stringProp('Exact immutable PromptVersion to check.'),
      providerId: { type: 'string', enum: ['mock', 'runninghub', 'comfyui'], description: 'Provider to validate against.' },
      megapixels: { type: 'number', enum: [0.6, 0.8, 1, 1.2] },
    }, ['shotId', 'promptVersionId', 'providerId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'inspect_jobs',
    description: 'List current local background jobs. This does not retry or cancel jobs.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_runninghub_config',
    description: 'Read RunningHub region, video and Storyboard profiles, and whether an API key is configured. Never returns the API key.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'set_runninghub_region',
    description: 'Set the RunningHub account region. Changing region invalidates video and Storyboard node detection because credentials and App IDs cannot cross regions.',
    inputSchema: objectSchema({
      region: { type: 'string', enum: ['cn', 'global'], description: 'cn for runninghub.cn; global for runninghub.ai.' },
    }, ['region']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'configure_runninghub_video_profile',
    description: 'Update safe RunningHub video AI App fields while preserving server-owned node evidence and verification. App or mapping changes become unconfigured until node detection runs again.',
    inputSchema: objectSchema({
      appId: stringProp('Published RunningHub video AI App ID for the selected region.'),
      concurrency: { type: 'integer', minimum: 1, maximum: 4, description: 'Maximum active remote tasks. Prefer 1.' },
      refVideoAppId: { type: 'string', description: 'Optional AI App ID used only for camera reference video.' },
      apps: {
        type: 'array',
        description: 'Optional user-managed AI App list.',
        items: objectSchema({
          id: stringProp('Stable local entry ID.'),
          name: stringProp('User-facing name.'),
          appId: stringProp('RunningHub AI App ID.'),
          description: { type: 'string' },
        }, ['id', 'name', 'appId']),
      },
      inputs: { type: 'object', description: 'Optional business-input to node mapping. Edit only after inspecting detected nodes.', additionalProperties: true },
      providerParamBindings: { type: 'object', description: 'Optional custom parameter bindings with exact nodeId and fieldName.', additionalProperties: true },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'detect_runninghub_video_nodes',
    description: 'Call RunningHub apiCallDemo to discover and heuristically map video AI App nodes. This is not a render and cannot mark the profile verified.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'configure_runninghub_storyboard_profile',
    description: 'Update safe optional Storyboard AI App fields. App or mapping changes become unconfigured until node detection runs again.',
    inputSchema: objectSchema({
      enabled: { type: 'boolean' },
      appId: stringProp('Published RunningHub Storyboard AI App ID for the selected region.'),
      estimatedCostCny: { type: ['number', 'null'], minimum: 0, description: 'Optional estimate per paid image task.' },
      inputs: { type: 'object', description: 'Optional Prompt, Size, and Layout Image node mappings.', additionalProperties: true },
      sizeValues: { type: 'object', description: 'Optional values expected for 3, 6, and 9 panel layouts.', additionalProperties: true },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'detect_runninghub_storyboard_nodes',
    description: 'Call RunningHub apiCallDemo to discover Prompt, Size, and Layout Image nodes. This does not generate an image.',
    inputSchema: objectSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

async function ensureSession() {
  if (sessionCookie) return;
  const response = await fetch(`${API_BASE}/api/session`);
  if (!response.ok) throw new Error(`H3Mise session bootstrap failed: HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/h3mise_session=([^;]+)/);
  if (!match) throw new Error('H3Mise did not return a session cookie');
  sessionCookie = `h3mise_session=${match[1]}`;
}

async function api(method, path, body) {
  await ensureSession();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Cookie: sessionCookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => {
    throw new Error(`Cannot reach H3Mise at ${API_BASE}: ${error.message}`);
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    if (response.status === 401) sessionCookie = '';
    const message = data && typeof data === 'object' && 'error' in data ? data.error : `HTTP ${response.status}`;
    throw new Error(`H3Mise ${method} ${path} failed: ${message}`);
  }
  return data;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'h3mise_status': {
      const [health, currentProject] = await Promise.all([
        api('GET', '/api/health'),
        api('GET', '/api/current-project'),
      ]);
      return { apiBase: API_BASE, health, currentProject };
    }
    case 'list_projects': return api('GET', '/api/projects');
    case 'open_project': return api('POST', `/api/projects/${encodeURIComponent(requireString(args, 'projectId'))}/open`, { force: args.force === true });
    case 'get_production_overview': return api('GET', '/api/production');
    case 'list_shots': return api('GET', '/api/shots');
    case 'inspect_shot': return api('GET', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}`);
    case 'build_context_package': return api('POST', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}/context-package`, { task: requireString(args, 'task') });
    case 'parse_director_plan': return api('POST', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}/plans/parse`, { text: requireString(args, 'text') });
    case 'apply_director_plan': {
      if (!args.plan || typeof args.plan !== 'object' || Array.isArray(args.plan)) throw new Error('plan is required');
      return api('POST', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}/plans`, { plan: args.plan, source: 'external_ai' });
    }
    case 'compile_prompt': return api('POST', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}/prompts/compile`, {
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
    });
    case 'create_revision_prompt': return api('POST', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}/prompts/raw`, {
      text: requireString(args, 'text'),
      mode: requireString(args, 'mode'),
      source: 'manual',
      sourceTakeId: requireString(args, 'sourceTakeId'),
      revisionReason: requireString(args, 'revisionReason'),
      preservedAspects: args.preservedAspects,
    });
    case 'review_take': return api('PATCH', `/api/takes/${encodeURIComponent(requireString(args, 'takeId'))}`, {
      ...(args.notes === undefined ? {} : { notes: args.notes }),
      review: {
        pictureVerdict: args.pictureVerdict,
        audioVerdict: args.audioVerdict,
        usableRanges: args.usableRanges,
        changeRequest: args.changeRequest,
        preservedAspects: args.preservedAspects,
        iterationOutcome: args.iterationOutcome,
      },
    });
    case 'run_preflight': return api('POST', `/api/shots/${encodeURIComponent(requireString(args, 'shotId'))}/preflight`, {
      promptVersionId: requireString(args, 'promptVersionId'),
      providerId: requireString(args, 'providerId'),
      ...(args.megapixels === undefined ? {} : { megapixels: args.megapixels }),
    });
    case 'inspect_jobs': return api('GET', '/api/jobs');
    case 'get_runninghub_config': {
      const [apiKey, videoProfile, storyboardProfile] = await Promise.all([
        api('GET', '/api/providers/runninghub/apikey'),
        api('GET', '/api/providers/runninghub/profile'),
        api('GET', '/api/providers/runninghub/storyboard-profile'),
      ]);
      return { apiKey, videoProfile, storyboardProfile };
    }
    case 'set_runninghub_region': {
      if (args.region !== 'cn' && args.region !== 'global') throw new Error('region must be cn or global');
      return api('PUT', '/api/providers/runninghub/region', { region: args.region });
    }
    case 'configure_runninghub_video_profile': {
      const current = await api('GET', '/api/providers/runninghub/profile');
      if (!current || typeof current !== 'object') throw new Error('RunningHub video profile is unavailable');
      const allowed = ['appId', 'concurrency', 'refVideoAppId', 'apps', 'inputs', 'providerParamBindings'];
      const supplied = allowed.filter((key) => Object.hasOwn(args, key));
      if (!supplied.length) throw new Error(`provide at least one of: ${allowed.join(', ')}`);
      const update = { ...current };
      for (const key of supplied) update[key] = args[key];
      if (Object.hasOwn(args, 'inputs')) update.inputs = { ...current.inputs, ...args.inputs };
      return api('PUT', '/api/providers/runninghub/profile', update);
    }
    case 'detect_runninghub_video_nodes': return api('POST', '/api/providers/runninghub/verify', {});
    case 'configure_runninghub_storyboard_profile': {
      const current = await api('GET', '/api/providers/runninghub/storyboard-profile');
      if (!current || typeof current !== 'object') throw new Error('RunningHub Storyboard profile is unavailable');
      const allowed = ['enabled', 'appId', 'estimatedCostCny', 'inputs', 'sizeValues'];
      const supplied = allowed.filter((key) => Object.hasOwn(args, key));
      if (!supplied.length) throw new Error(`provide at least one of: ${allowed.join(', ')}`);
      const update = { ...current };
      for (const key of supplied) update[key] = args[key];
      if (Object.hasOwn(args, 'inputs')) update.inputs = { ...current.inputs, ...args.inputs };
      if (Object.hasOwn(args, 'sizeValues')) update.sizeValues = { ...current.sizeValues, ...args.sizeValues };
      return api('PUT', '/api/providers/runninghub/storyboard-profile', update);
    }
    case 'detect_runninghub_storyboard_nodes': return api('POST', '/api/providers/runninghub/storyboard-profile/verify', {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.id === undefined) return;
  try {
    switch (message.method) {
      case 'initialize':
        result(message.id, {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'h3mise', version: '0.1.0' },
          instructions: 'H3Mise is a local-first director workstation. Inspect the current project and canonical Context Package before writing. Save DirectorPlans and prompts as new immutable versions. Never claim a render happened from Preflight. This MCP server cannot accept or reveal API keys, submit paid renders, select Takes, delete work, or overwrite existing Takes. RunningHub node detection is not a render and only reaches nodes_detected. Record picture and audio judgments separately. Keep the director in control.',
        });
        return;
      case 'ping':
        result(message.id, {});
        return;
      case 'tools/list':
        result(message.id, { tools });
        return;
      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string') throw new Error('tool name is required');
        try {
          const value = await callTool(name, message.params?.arguments ?? {});
          result(message.id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
        } catch (toolError) {
          result(message.id, {
            isError: true,
            content: [{ type: 'text', text: toolError instanceof Error ? toolError.message : String(toolError) }],
          });
        }
        return;
      }
      default:
        error(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (requestError) {
    error(message.id, -32603, requestError instanceof Error ? requestError.message : String(requestError));
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    error(null, -32700, 'Parse error');
    return;
  }
  void handle(message);
});

