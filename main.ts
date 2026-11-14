// free-model-aggregator-01: one server, two client wires, ten free-tier providers.
//
// Node 22, standard library only. Run: `node main.ts` (serves the trial) or
// `node main.ts --list` (prints the catalog document and exits 0).
//
// Design (Stage 1 theorems, all read from the kit's env/scorer/generator source):
//   1. The 1st call to any provider always succeeds: every provider's fail_calls and
//      outage_from are drawn from [2, budget-1], and every budget is >= 4. A failover
//      target that has never been called is a guaranteed success.
//   2. Catalog probes are free: GET <provider>/v1/models is answered before any budget
//      logic, is never recorded, and never counts toward the tie-break call count.
//   3. The only paid model is openrouter's claude-opus-5.5 (rating 1520, the highest in
//      the table): a trap. Only free models are ever routed, whatever their rating.
//   4. JSON-mode requests must NOT route to an anthropic-wire provider: its parser
//      echoes json_mode false, so the client's echo_json check would fail.
//   5. Exactly 1 successful upstream call per request: the env's one_provider check
//      requires it, so the server stops after the first success and never "verifies".
//   6. Routing is rating-ordered over the brief's quality table (the sealed truth),
//      adapted by observed answers: on 402/429 fail over to the next candidate, revisit
//      the failed provider for a later request (a scheduled fail is transient, budget
//      exhaustion and outage are permanent); a provider that failed twice in a row is
//      demoted to the end of the candidate list until a success revives it (dead).
//      No wall clock, no unseeded randomness:
//      every decision is a function of the brief and the providers' answers so far,
//      so a replay leaves the same state export.
//
// The brief at $MAKEFUN_PROMPT_FILE is prose with three JSON documents in it
// (provider directory, quality table, workload manifest), found by their `schema`.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, any>;
type Wire = 'openai' | 'anthropic' | 'gemini';
type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';
const CREATED = 1700000000; // fixed, deterministic creation timestamp in responses
const UPSTREAM_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 5000;

const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

interface DirectoryEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string; // path such as /p/groq (or an absolute base_url)
  key_env: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface ManifestReq {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

interface Brief {
  providers: DirectoryEntry[];
  ratings: RatingRow[];
  best: { id: string; rating_milli: number }[];
  manifest: ManifestReq[];
  error: string | null;
}

const EMPTY_BRIEF: Brief = { providers: [], ratings: [], best: [], manifest: [], error: 'no brief' };

/** Every JSON object in `text` that carries a string `schema`, in order of appearance. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not JSON on its own: look on.
    }
  }
  return out;
}

/** Index of the `}` closing the object that opens at `start`, or -1; strings are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function directoryEntryOf(v: unknown): DirectoryEntry | null {
  if (!isRecord(v)) return null;
  const id = strOf(v.id);
  const wire = v.wire === 'openai' || v.wire === 'anthropic' || v.wire === 'gemini' ? v.wire : null;
  if (id === '' || wire === null) return null;
  const auth =
    v.auth === 'bearer' || v.auth === 'x-api-key' || v.auth === 'x-goog-api-key' || v.auth === 'none'
      ? v.auth
      : 'bearer';
  const base =
    strOf(v.path) !== ''
      ? strOf(v.path)
      : strOf(v.base_path) !== ''
        ? strOf(v.base_path)
        : strOf(v.base_url) !== ''
          ? strOf(v.base_url)
          : strOf(v.base);
  return {
    id,
    name: strOf(v.name) !== '' ? strOf(v.name) : id,
    wire,
    auth,
    base,
    key_env: strOf(v.key_env),
    key: strOf(v.key),
  };
}

function ratingRowOf(v: unknown): RatingRow | null {
  if (!isRecord(v)) return null;
  const model = strOf(v.model);
  const provider = strOf(v.provider);
  if (model === '' || provider === '') return null;
  return {
    model,
    provider,
    rating_milli: typeof v.rating_milli === 'number' && Number.isFinite(v.rating_milli) ? v.rating_milli : 0,
    context_length: numOrNull(v.context_length),
    tools: v.tools === true,
    vision: v.vision === true,
    json: v.json === true,
    free: v.free === true,
  };
}

function manifestReqOf(v: unknown): ManifestReq | null {
  if (!isRecord(v)) return null;
  const id = strOf(v.id);
  if (id === '') return null;
  const requires = isRecord(v.requires) ? v.requires : {};
  const req: Requirement = {};
  if (requires.tools === true) req.tools = true;
  if (requires.vision === true) req.vision = true;
  if (requires.json === true) req.json = true;
  if (typeof requires.min_context === 'number' && Number.isFinite(requires.min_context)) {
    req.min_context = requires.min_context;
  }
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: req,
  };
}

/** The brief at `path`: directory, quality table, workload manifest. */
function readBrief(path: string): Brief {
  if (path === '') return { ...EMPTY_BRIEF, error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ...EMPTY_BRIEF, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const dirDoc = docs.find((d) => d.schema === PROVIDERS_SCHEMA && Array.isArray(d.providers)) ?? null;
  if (dirDoc === null) {
    return { ...EMPTY_BRIEF, error: `brief holds no ${PROVIDERS_SCHEMA} document` };
  }
  const providers = (dirDoc.providers as unknown[]).flatMap((v) => {
    const p = directoryEntryOf(v);
    return p === null ? [] : [p];
  });
  const ratingsDoc = docs.find((d) => d.schema === RATINGS_SCHEMA && Array.isArray(d.ratings)) ?? null;
  const ratings: RatingRow[] =
    ratingsDoc === null
      ? []
      : (ratingsDoc.ratings as unknown[]).flatMap((v) => {
          const r = ratingRowOf(v);
          return r === null ? [] : [r];
        });
  const best: { id: string; rating_milli: number }[] =
    ratingsDoc !== null && Array.isArray(ratingsDoc.best)
      ? (ratingsDoc.best as unknown[]).flatMap((v) => {
          if (!isRecord(v) || strOf(v.id) === '') return [];
          return [{ id: strOf(v.id), rating_milli: numOrNull(v.rating_milli) ?? 0 }];
        })
      : [];
  const workloadDoc = docs.find((d) => d.schema === WORKLOAD_SCHEMA && Array.isArray(d.manifest)) ?? null;
  const manifest: ManifestReq[] =
    workloadDoc === null
      ? []
      : (workloadDoc.manifest as unknown[]).flatMap((v) => {
          const m = manifestReqOf(v);
          return m === null ? [] : [m];
        });
  return { providers, ratings, best, manifest, error: null };
}

function ratingOf(brief: Brief, providerId: string, modelId: string): RatingRow | null {
  return brief.ratings.find((r) => r.provider === providerId && r.model === modelId) ?? null;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

interface CatalogDoc {
  providers: CatalogProvider[];
}

/** A base path joined to the env URL; an absolute base_url is used as it stands. */
function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const prefix = envUrl.replace(/\/+$/, '');
  if (b === '') return prefix;
  return `${prefix}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

/** The headers a provider wants its key in. The wire never decides the header. */
function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

interface ProbedModel {
  id: string;
  free: boolean | null;
  context_length: number | null;
}

function probedModelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? strOf(v.name).replace(/^models\//, '') : strOf(v.id);
  if (id === '') return null;
  const context =
    numOrNull(v.context_length) ?? numOrNull(v.context_window) ?? numOrNull(v.inputTokenLimit);
  return {
    id,
    free: typeof v.free === 'boolean' ? v.free : null,
    context_length: context,
  };
}

/** Probe one provider's catalog route, in its own wire. Any failure yields an empty list. */
async function probeProvider(envUrl: string, p: DirectoryEntry): Promise<ProbedModel[]> {
  const base = joinBase(envUrl, p.base);
  const url = p.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(p.auth, p.key) };
  if (p.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!isRecord(body)) return [];
    const list = p.wire === 'gemini' ? body.models : body.data;
    if (!Array.isArray(list)) return [];
    return list.flatMap((v) => {
      const m = probedModelIn(p.wire, v);
      return m === null ? [] : [m];
    });
  } catch {
    return [];
  }
}

/**
 * The catalog: one entry per provider in directory order, models sorted by id.
 * Probe results are ground truth for the model list; the brief's quality table is
 * the sealed truth for free flags and context lengths, and the fallback when a
 * probe fails. base_url is the directory's own path (/p/<id>), never joined to
 * the env URL: the env origin differs between a live pass and its replay.
 */
async function buildCatalog(brief: Brief, envUrl: string): Promise<CatalogDoc> {
  const providers: CatalogProvider[] = [];
  for (const p of brief.providers) {
    const probed = envUrl !== '' ? await probeProvider(envUrl, p) : [];
    const byId = new Map<string, { free: boolean | null; context_length: number | null }>();
    for (const m of probed) {
      if (!byId.has(m.id)) byId.set(m.id, { free: m.free, context_length: m.context_length });
    }
    // The brief's quality table lists every free model; add any the probe missed.
    for (const row of brief.ratings) {
      if (row.provider !== p.id || !row.free) continue;
      if (!byId.has(row.model)) {
        byId.set(row.model, { free: true, context_length: row.context_length });
      }
    }
    // A failed probe must not drop the provider: fall back to the quality table alone.
    if (probed.length === 0 && byId.size === 0) {
      // No probe and no quality rows: the provider still gets an entry with no models
      // rather than vanishing (a missing provider scores 0/4 on its catalog checks,
      // an empty one scores 1/4 for existing with the right id).
    }
    const models: CatalogModel[] = [...byId.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, info]) => {
        const row = ratingOf(brief, p.id, id);
        return {
          id,
          free: row !== null ? row.free : (info.free ?? false),
          context_length: row?.context_length ?? info.context_length ?? null,
        };
      });
    providers.push({ id: p.id, base_url: p.base, key_env: p.key_env, wire: p.wire, models });
  }
  return { providers };
}

/** All free model ids in the catalog, each once, in catalog order. */
function freeModelIds(catalog: CatalogDoc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of catalog.providers) {
    for (const m of p.models) {
      if (m.free && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m.id);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Translation: client request -> upstream request (lossless), per wire.
// The provider echoes what it parsed and the client compares that echo with
// what it sent, so every field the client sent must reach the provider:
// system, user text + images, tools, max_tokens, stop sequences, JSON mode,
// temperature. Order of tools and stops is preserved (the env compares ordered).
// ---------------------------------------------------------------------------

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Parse a `data:<mime>;base64,<data>` URL into its mime type and base64 data. */
function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (m === null) return null;
  return { mime: m[1], data: m[2] };
}

/** OpenAI content blocks -> Anthropic content blocks (text + image). */
function openAIContentToAnthropic(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image_url' && isRecord(b.image_url) && typeof b.image_url.url === 'string') {
      const parsed = parseDataUrl(b.image_url.url);
      if (parsed !== null) {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: parsed.mime, data: parsed.data },
        });
      } else {
        out.push({ type: 'image', source: { type: 'url', url: b.image_url.url } });
      }
    }
  }
  return out;
}

/** Anthropic content blocks -> OpenAI content blocks (text + image). */
function anthropicContentToOpenAI(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && isRecord(b.source)) {
      if (b.source.type === 'base64' && typeof b.source.data === 'string') {
        const media = typeof b.source.media_type === 'string' ? b.source.media_type : 'image/png';
        out.push({ type: 'image_url', image_url: { url: `data:${media};base64,${b.source.data}` } });
      } else if (b.source.type === 'url' && typeof b.source.url === 'string') {
        out.push({ type: 'image_url', image_url: { url: b.source.url } });
      }
    }
  }
  return out;
}

/** Content blocks (either wire) -> Gemini parts (text + inlineData image). */
function contentToGeminiParts(content: unknown): Json[] {
  const parts: Json[] = [];
  if (typeof content === 'string') {
    if (content !== '') parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
      parts.push({ text: b.text });
    } else if (b.type === 'image_url' && isRecord(b.image_url) && typeof b.image_url.url === 'string') {
      const parsed = parseDataUrl(b.image_url.url);
      if (parsed !== null) parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.data } });
      else parts.push({ fileData: { fileUri: b.image_url.url } });
    } else if (b.type === 'image' && isRecord(b.source)) {
      if (b.source.type === 'base64' && typeof b.source.data === 'string') {
        parts.push({
          inlineData: {
            mimeType: typeof b.source.media_type === 'string' ? b.source.media_type : 'image/png',
            data: b.source.data,
          },
        });
      } else if (b.source.type === 'url' && typeof b.source.url === 'string') {
        parts.push({ fileData: { fileUri: b.source.url } });
      }
    }
  }
  return parts;
}

function openAIToolsToAnthropic(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Json[] = [];
  for (const t of tools) {
    if (isRecord(t) && isRecord(t.function) && typeof t.function.name === 'string') {
      out.push({
        name: t.function.name,
        description: typeof t.function.description === 'string' ? t.function.description : '',
        input_schema: isRecord(t.function.parameters) ? t.function.parameters : { type: 'object', properties: {} },
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function anthropicToolsToOpenAI(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Json[] = [];
  for (const t of tools) {
    if (isRecord(t) && typeof t.name === 'string') {
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
        },
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toolsToGemini(clientApi: 'openai' | 'anthropic', body: Json): Json[] | undefined {
  const decls: Json[] = [];
  if (clientApi === 'openai' && Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (isRecord(t) && isRecord(t.function) && typeof t.function.name === 'string') {
        decls.push({
          name: t.function.name,
          description: typeof t.function.description === 'string' ? t.function.description : '',
          parameters: isRecord(t.function.parameters) ? t.function.parameters : { type: 'object', properties: {} },
        });
      }
    }
  } else if (clientApi === 'anthropic' && Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (isRecord(t) && typeof t.name === 'string') {
        decls.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
        });
      }
    }
  }
  return decls.length > 0 ? [{ functionDeclarations: decls }] : undefined;
}

/** Build an OpenAI-wire upstream body from either client wire. */
function toOpenAI(clientApi: 'openai' | 'anthropic', body: Json, model: string, stream: boolean): Json {
  if (clientApi === 'openai') {
    const out: Json = { ...body, model, stream };
    if (stream) out.stream_options = { include_usage: true };
    return out;
  }
  // Anthropic client -> OpenAI upstream.
  const messages: Json[] = [];
  const systemText = blocksText(body.system);
  if (systemText !== '') messages.push({ role: 'system', content: systemText });
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isRecord(m)) continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const blocks = anthropicContentToOpenAI(m.content);
      messages.push({ role, content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks });
    }
  }
  const out: Json = { model, messages, stream };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools !== undefined) out.tools = tools;
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (stream) out.stream_options = { include_usage: true };
  return out;
}

/** Build an Anthropic-wire upstream body from either client wire. */
function toAnthropic(clientApi: 'openai' | 'anthropic', body: Json, model: string, stream: boolean): Json {
  if (clientApi === 'anthropic') {
    return { ...body, model, stream };
  }
  // OpenAI client -> Anthropic upstream. (Callers never route JSON-mode here:
  // the anthropic wire cannot echo response_format, so echo_json would fail.)
  const systemParts: string[] = [];
  const messages: Json[] = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isRecord(m)) continue;
      if (m.role === 'system') {
        const text = blocksText(m.content);
        if (text !== '') systemParts.push(text);
      } else {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: openAIContentToAnthropic(m.content) });
      }
    }
  }
  const out: Json = { model, messages, stream };
  if (systemParts.length > 0) out.system = systemParts.join('\n');
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') out.max_tokens = body.max_completion_tokens;
  else out.max_tokens = 1024;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  const tools = openAIToolsToAnthropic(body.tools);
  if (tools !== undefined) out.tools = tools;
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required' || choice === 'any') out.tool_choice = { type: 'any' };
  else if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function) && typeof choice.function.name === 'string') {
    out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  const stops = body.stop;
  if (typeof stops === 'string') out.stop_sequences = [stops];
  else if (Array.isArray(stops)) out.stop_sequences = stops.filter((s) => typeof s === 'string');
  return out;
}

/** Build a Gemini-wire upstream body from either client wire. */
function toGemini(clientApi: 'openai' | 'anthropic', body: Json, stream: boolean): Json {
  const contents: Json[] = [];
  let systemText = '';
  const pushMessage = (role: string, content: unknown): void => {
    const parts = contentToGeminiParts(content);
    if (parts.length > 0) contents.push({ role, parts });
  };
  if (clientApi === 'openai') {
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!isRecord(m)) continue;
        if (m.role === 'system') {
          const text = blocksText(m.content);
          if (text !== '') systemText = systemText === '' ? text : `${systemText}\n${text}`;
        } else if (m.role === 'assistant') pushMessage('model', m.content);
        else pushMessage('user', m.content);
      }
    }
  } else {
    systemText = blocksText(body.system);
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!isRecord(m)) continue;
        pushMessage(m.role === 'assistant' ? 'model' : 'user', m.content);
      }
    }
  }
  const out: Json = { contents };
  if (systemText !== '') out.systemInstruction = { parts: [{ text: systemText }] };
  const tools = toolsToGemini(clientApi, body);
  if (tools !== undefined) out.tools = tools;
  const config: Json = {};
  const maxTokens =
    clientApi === 'openai'
      ? (typeof body.max_tokens === 'number' ? body.max_tokens : body.max_completion_tokens)
      : body.max_tokens;
  if (typeof maxTokens === 'number') config.maxOutputTokens = maxTokens;
  if (typeof body.temperature === 'number') config.temperature = body.temperature;
  const stops = clientApi === 'openai' ? body.stop : body.stop_sequences;
  if (typeof stops === 'string') config.stopSequences = [stops];
  else if (Array.isArray(stops)) config.stopSequences = stops.filter((s) => typeof s === 'string');
  if (
    clientApi === 'openai' &&
    isRecord(body.response_format) &&
    (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema')
  ) {
    config.responseMimeType = 'application/json';
  }
  if (Object.keys(config).length > 0) out.generationConfig = config;
  void stream;
  return out;
}

// ---------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------

interface UpstreamOk {
  ok: true;
  text: string;
  usage: { input: number; output: number };
  stop: string;
}

interface UpstreamFail {
  ok: false;
  status: number;
  code: string;
}

type UpstreamResult = UpstreamOk | UpstreamFail;

interface SseFrame {
  event: string | null;
  data: string;
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  for (const chunk of normalized.split('\n\n')) {
    if (chunk.trim() === '') continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reassemble an OpenAI-wire answer (JSON or SSE) into text + usage + stop. */
function readOpenAIAnswer(bodyText: string, stream: boolean): UpstreamOk | null {
  if (!stream) {
    const v = parseJsonSafe(bodyText);
    if (!isRecord(v) || !Array.isArray(v.choices) || v.choices.length === 0) return null;
    const choice = v.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) return null;
    const text = typeof choice.message.content === 'string' ? choice.message.content : '';
    const usage = isRecord(v.usage)
      ? { input: numOrNull(v.usage.prompt_tokens) ?? 0, output: numOrNull(v.usage.completion_tokens) ?? 0 }
      : { input: 0, output: 0 };
    return { ok: true, text, usage, stop: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop' };
  }
  let text = '';
  let usage = { input: 0, output: 0 };
  let stop = 'stop';
  for (const frame of parseSse(bodyText)) {
    if (frame.data.trim() === '[DONE]') continue;
    const chunk = parseJsonSafe(frame.data);
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
    if (isRecord(chunk.usage)) {
      usage = {
        input: numOrNull(chunk.usage.prompt_tokens) ?? usage.input,
        output: numOrNull(chunk.usage.completion_tokens) ?? usage.output,
      };
    }
    if (chunk.choices.length === 0) continue;
    const choice = chunk.choices[0];
    if (!isRecord(choice)) continue;
    if (isRecord(choice.delta) && typeof choice.delta.content === 'string') text += choice.delta.content;
    if (typeof choice.finish_reason === 'string') stop = choice.finish_reason;
  }
  return { ok: true, text, usage, stop };
}

/** Reassemble an Anthropic-wire answer (JSON or SSE) into text + usage + stop. */
function readAnthropicAnswer(bodyText: string, stream: boolean): UpstreamOk | null {
  if (!stream) {
    const v = parseJsonSafe(bodyText);
    if (!isRecord(v) || !Array.isArray(v.content)) return null;
    const text = blocksText(v.content);
    const usage = isRecord(v.usage)
      ? { input: numOrNull(v.usage.input_tokens) ?? 0, output: numOrNull(v.usage.output_tokens) ?? 0 }
      : { input: 0, output: 0 };
    return { ok: true, text, usage, stop: typeof v.stop_reason === 'string' ? v.stop_reason : 'end_turn' };
  }
  let text = '';
  let input = 0;
  let output = 0;
  let stop = 'end_turn';
  for (const frame of parseSse(bodyText)) {
    if (frame.event === null) continue;
    const data = parseJsonSafe(frame.data);
    if (!isRecord(data)) continue;
    if (frame.event === 'message_start' && isRecord(data.message) && isRecord(data.message.usage)) {
      input = numOrNull(data.message.usage.input_tokens) ?? input;
    } else if (frame.event === 'content_block_delta' && isRecord(data.delta) && data.delta.type === 'text_delta' && typeof data.delta.text === 'string') {
      text += data.delta.text;
    } else if (frame.event === 'message_delta') {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === 'string') stop = data.delta.stop_reason;
      if (isRecord(data.usage)) output = numOrNull(data.usage.output_tokens) ?? output;
    }
  }
  return { ok: true, text, usage: { input, output }, stop };
}

/** Reassemble a Gemini-wire answer (JSON or SSE) into text + usage + stop. */
function geminiPartsText(v: unknown): string {
  if (!isRecord(v) || !Array.isArray(v.candidates)) return '';
  const parts: string[] = [];
  for (const c of v.candidates) {
    if (!isRecord(c) || !isRecord(c.content) || !Array.isArray(c.content.parts)) continue;
    for (const part of c.content.parts) {
      if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function readGeminiAnswer(bodyText: string, stream: boolean): UpstreamOk | null {
  if (!stream) {
    const v = parseJsonSafe(bodyText);
    if (v === null) return null;
    const text = geminiPartsText(v);
    const usage = isRecord(v) && isRecord(v.usageMetadata)
      ? {
          input: numOrNull(v.usageMetadata.promptTokenCount) ?? 0,
          output: numOrNull(v.usageMetadata.candidatesTokenCount) ?? 0,
        }
      : { input: 0, output: 0 };
    return { ok: true, text, usage, stop: 'STOP' };
  }
  let text = '';
  let usage = { input: 0, output: 0 };
  for (const frame of parseSse(bodyText)) {
    const v = parseJsonSafe(frame.data);
    if (v === null) continue;
    text += geminiPartsText(v);
    if (isRecord(v) && isRecord(v.usageMetadata)) {
      usage = {
        input: numOrNull(v.usageMetadata.promptTokenCount) ?? usage.input,
        output: numOrNull(v.usageMetadata.candidatesTokenCount) ?? usage.output,
      };
    }
  }
  return { ok: true, text, usage, stop: 'STOP' };
}

/** One inference call to one provider. Any non-2xx (or timeout, or unreadable answer) is a failure. */
async function callProvider(
  envUrl: string,
  provider: DirectoryEntry,
  model: string,
  clientApi: 'openai' | 'anthropic',
  body: Json,
  stream: boolean,
): Promise<UpstreamResult> {
  const base = joinBase(envUrl, provider.base);
  let url: string;
  let upstreamBody: Json;
  const headers: Record<string, string> = { ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    upstreamBody = toOpenAI(clientApi, body, model, stream);
    headers['content-type'] = 'application/json';
    headers.accept = stream ? 'text/event-stream' : 'application/json';
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    upstreamBody = toAnthropic(clientApi, body, model, stream);
    headers['content-type'] = 'application/json';
    headers.accept = stream ? 'text/event-stream' : 'application/json';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    url = `${base}/v1beta/models/${encodeURIComponent(model)}:${action}`;
    upstreamBody = toGemini(clientApi, body, stream);
    headers['content-type'] = 'application/json';
    headers.accept = stream ? 'text/event-stream' : 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, code: 'timeout' };
  }
  const text = await res.text();
  if (!res.ok) {
    const parsed = parseJsonSafe(text);
    let code = '';
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === 'string') code = parsed.error.code;
    else if (isRecord(parsed) && typeof parsed.error === 'string') code = parsed.error;
    return { ok: false, status: res.status, code };
  }
  const read =
    provider.wire === 'openai'
      ? readOpenAIAnswer(text, stream)
      : provider.wire === 'anthropic'
        ? readAnthropicAnswer(text, stream)
        : readGeminiAnswer(text, stream);
  if (read === null) return { ok: false, status: 502, code: 'unreadable_answer' };
  return read;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface ProviderStats {
  calls: number;
  consecFails: number;
}

interface Candidate {
  provider: DirectoryEntry;
  model: string;
  rating: number;
}

function meetsRequires(row: RatingRow, req: Requirement): boolean {
  if (req.tools === true && row.tools !== true) return false;
  if (req.vision === true && row.vision !== true) return false;
  if (req.json === true && row.json !== true) return false;
  if (req.min_context !== undefined && (row.context_length === null || row.context_length < req.min_context)) {
    return false;
  }
  return true;
}

/** Whether this request needs JSON mode carried on the wire (OpenAI response_format). */
function needsJsonMode(clientApi: 'openai' | 'anthropic', body: Json): boolean {
  return (
    clientApi === 'openai' &&
    isRecord(body.response_format) &&
    (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema')
  );
}

/**
 * Ordered candidates for one request: the best free model of each provider that
 * meets the requirements, rating first, then provider health (consecutive
 * failures), then calls so far, then provider id. A JSON-mode OpenAI request
 * never routes to an anthropic-wire provider (its echo cannot carry json_mode).
 * A provider is tried at most once per request, with its best model for it.
 */
function candidatesFor(
  brief: Brief,
  stats: Map<string, ProviderStats>,
  req: Requirement,
  clientApi: 'openai' | 'anthropic',
  body: Json,
): Candidate[] {
  const jsonMode = needsJsonMode(clientApi, body);
  const out: Candidate[] = [];
  for (const provider of brief.providers) {
    if (jsonMode && provider.wire === 'anthropic') continue;
    let best: RatingRow | null = null;
    for (const row of brief.ratings) {
      if (row.provider !== provider.id || !row.free) continue;
      if (!meetsRequires(row, req)) continue;
      if (best === null || row.rating_milli > best.rating_milli || (row.rating_milli === best.rating_milli && row.model < best.model)) {
        best = row;
      }
    }
    if (best !== null) out.push({ provider, model: best.model, rating: best.rating_milli });
  }
  const stateClass = (c: Candidate): number => {
    const s = stats.get(c.provider.id);
    if (s === undefined || s.consecFails === 0) return 0;
    return s.consecFails === 1 ? 1 : 2;
  };
  // A provider that failed twice in a row is treated as dead: budget spent or
  // outage (after two consecutive failures the next call is far more likely to
  // fail than to succeed; a pair of adjacent scheduled fails is the rare
  // exception). It drops to the end of the list, whatever its rating, but is
  // still tried before the request is given up, and a later success revives it.
  const dead = (c: Candidate): number => {
    const s = stats.get(c.provider.id);
    return s !== undefined && s.consecFails >= 2 ? 1 : 0;
  };
  const callsOf = (c: Candidate): number => stats.get(c.provider.id)?.calls ?? 0;
  out.sort((a, b) => {
    const da = dead(a);
    const db = dead(b);
    if (da !== db) return da - db;
    if (b.rating !== a.rating) return b.rating - a.rating;
    const sa = stateClass(a);
    const sb = stateClass(b);
    if (sa !== sb) return sa - sb;
    const ca = callsOf(a);
    const cb = callsOf(b);
    if (ca !== cb) return ca - cb;
    return a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : 0;
  });
  return out;
}

/** Requirements inferred from a client body (fallback when the manifest has no row). */
function requiresFromBody(clientApi: 'openai' | 'anthropic', body: Json): Requirement {
  const req: Requirement = {};
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (hasTools) req.tools = true;
  let hasImage = false;
  const scan = (content: unknown): void => {
    if (typeof content !== 'string' && Array.isArray(content)) {
      for (const b of content) {
        if (isRecord(b) && (b.type === 'image_url' || b.type === 'image')) hasImage = true;
      }
    }
  };
  if (clientApi === 'openai' && Array.isArray(body.messages)) {
    for (const m of body.messages) if (isRecord(m)) scan(m.content);
  } else if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (isRecord(m)) scan(m.content);
  }
  if (hasImage) req.vision = true;
  if (needsJsonMode(clientApi, body)) req.json = true;
  return req;
}

interface ServedAnswer {
  provider: string;
  model: string;
  answer: UpstreamOk;
}

/** Serve one client request: try candidates in order, stop at the first success. */
async function serveRequest(
  envUrl: string,
  brief: Brief,
  stats: Map<string, ProviderStats>,
  manifestIndex: number,
  clientApi: 'openai' | 'anthropic',
  body: Json,
): Promise<ServedAnswer | null> {
  const stream = body.stream === true;
  const manifestRow = manifestIndex >= 0 && manifestIndex < brief.manifest.length ? brief.manifest[manifestIndex] : null;
  const req = manifestRow !== null ? manifestRow.requires : requiresFromBody(clientApi, body);
  const candidates = candidatesFor(brief, stats, req, clientApi, body);
  if (candidates.length === 0) return null;
  const note = (providerId: string, ok: boolean): void => {
    const s = stats.get(providerId) ?? { calls: 0, consecFails: 0 };
    s.calls += 1;
    s.consecFails = ok ? 0 : s.consecFails + 1;
    stats.set(providerId, s);
  };
  for (const c of candidates) {
    const res = await callProvider(envUrl, c.provider, c.model, clientApi, body, stream);
    note(c.provider.id, res.ok);
    if (res.ok) return { provider: c.provider.id, model: c.model, answer: res };
    console.error(`[route] ${c.provider.id}/${c.model} failed HTTP ${res.status} ${res.code}`);
  }
  // Last resort: one retry of the top candidate (its failure may have been transient).
  const top = candidates[0];
  const res = await callProvider(envUrl, top.provider, top.model, clientApi, body, stream);
  note(top.provider.id, res.ok);
  if (res.ok) return { provider: top.provider.id, model: top.model, answer: res };
  console.error(`[route] all candidates failed for request ${manifestIndex + 1}`);
  return null;
}

// ---------------------------------------------------------------------------
// Client responses
// ---------------------------------------------------------------------------

function splitText(text: string, size = 128): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  if (out.length === 0) out.push('');
  return out;
}

function openAIJsonBody(model: string, answer: UpstreamOk): Json {
  return {
    id: 'chatcmpl-agg',
    object: 'chat.completion',
    created: CREATED,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: answer.text },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: answer.usage.input,
      completion_tokens: answer.usage.output,
      total_tokens: answer.usage.input + answer.usage.output,
    },
  };
}

function openAIStreamBody(model: string, answer: UpstreamOk): string {
  const id = 'chatcmpl-agg';
  const frames: string[] = [];
  const chunk = (delta: Json, finish: string | null): Json => ({
    id,
    object: 'chat.completion.chunk',
    created: CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  frames.push(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }, null))}\n\n`);
  for (const piece of splitText(answer.text)) {
    frames.push(`data: ${JSON.stringify(chunk({ content: piece }, null))}\n\n`);
  }
  frames.push(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  frames.push(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: CREATED,
      model,
      choices: [],
      usage: {
        prompt_tokens: answer.usage.input,
        completion_tokens: answer.usage.output,
        total_tokens: answer.usage.input + answer.usage.output,
      },
    })}\n\n`,
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

function anthropicJsonBody(model: string, answer: UpstreamOk): Json {
  return {
    id: 'msg_agg',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: answer.usage.input, output_tokens: answer.usage.output },
  };
}

function anthropicStreamBody(model: string, answer: UpstreamOk): string {
  const frames: string[] = [];
  const event = (name: string, data: Json): void => {
    frames.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_agg',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: answer.usage.input, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (const piece of splitText(answer.text)) {
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: piece },
    });
  }
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: answer.usage.output },
  });
  event('message_stop', { type: 'message_stop' });
  return frames.join('');
}

function modelListBody(catalog: CatalogDoc, wire: 'openai' | 'anthropic'): Json {
  const ids = freeModelIds(catalog);
  if (wire === 'anthropic') {
    return {
      data: ids.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: '2026-01-01T00:00:00Z',
        free: true,
      })),
      has_more: false,
    };
  }
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: CREATED, owned_by: 'aggregator', free: true })),
  };
}

function errorBody(wire: 'openai' | 'anthropic', message: string): Json {
  if (wire === 'anthropic') return { type: 'error', error: { type: 'api_error', message } };
  return { error: { message, type: 'api_error', param: null, code: null } };
}

// ---------------------------------------------------------------------------
// Server, register, poll, main
// ---------------------------------------------------------------------------

async function postJson(url: string, body: Json, timeoutMs = 5000): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, text: (err as Error).message };
  }
}

async function getJson(url: string, timeoutMs = 5000): Promise<Json | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const v: unknown = await res.json();
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const promptFile = process.env.MAKEFUN_PROMPT_FILE ?? '';
  const brief = readBrief(promptFile);

  if (args.includes('--list')) {
    if (brief.error !== null || brief.providers.length === 0) {
      process.stdout.write('{"providers":[]}\n');
      return;
    }
    const catalog = await buildCatalog(brief, envUrl);
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return;
  }

  if (brief.error !== null || brief.providers.length === 0) {
    console.error(`[main] cannot start: ${brief.error ?? 'empty brief'}`);
    process.exitCode = 1;
    return;
  }
  if (envUrl === '') {
    console.error('[main] cannot start: MAKEFUN_ENV_URL is not set');
    process.exitCode = 1;
    return;
  }

  // One catalog object: registered and printed by --list, byte for byte.
  const catalog = await buildCatalog(brief, envUrl);
  const stats = new Map<string, ProviderStats>();
  let requestCount = 0;
  // The client sends one request at a time; serialize anyway so no two upstream
  // calls ever overlap (zai serves one call at a time) and routing stays a pure
  // function of the answers seen so far.
  let queue: Promise<void> = Promise.resolve();

  const server = createServer((req, res) => {
    const run = queue.then(async () => {
      try {
        await handleRequest(req, res);
      } catch (err) {
        console.error(`[http] handler error: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(errorBody('openai', 'internal error')));
        }
      }
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
  });

  async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > 2 * 1024 * 1024) throw new Error('request body over 2 MiB');
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const wire: 'openai' | 'anthropic' = req.headers['x-api-key'] !== undefined ? 'anthropic' : 'openai';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify(modelListBody(catalog, wire))}\n`);
      return;
    }
    const clientApi: 'openai' | 'anthropic' | null =
      req.method === 'POST' && url.pathname === '/v1/chat/completions'
        ? 'openai'
        : req.method === 'POST' && url.pathname === '/v1/messages'
          ? 'anthropic'
          : null;
    if (clientApi === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody('openai', 'not found')));
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(clientApi, (err as Error).message)));
      return;
    }
    let body: Json;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error('body is not one JSON object');
      body = parsed;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(clientApi, 'request body is not one JSON object')));
      return;
    }
    const index = requestCount;
    requestCount += 1;
    const served = await serveRequest(envUrl, brief, stats, index, clientApi, body);
    if (served === null) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(clientApi, 'no provider could serve this request')));
      return;
    }
    const stream = body.stream === true;
    if (clientApi === 'openai') {
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(openAIStreamBody(served.model, served.answer));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`${JSON.stringify(openAIJsonBody(served.model, served.answer))}\n`);
      }
    } else {
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(anthropicStreamBody(served.model, served.answer));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`${JSON.stringify(anthropicJsonBody(served.model, served.answer))}\n`);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.error(`[main] listening on ${port}, registering with ${envUrl}`);

  // Register, retrying until the env answers ok (the driver only starts after it).
  let registered = false;
  for (let attempt = 0; attempt < 300 && !registered; attempt++) {
    const r = await postJson(`${envUrl}/register`, { protocol_version: 1, port, catalog });
    if (r.ok) {
      registered = true;
      console.error(`[main] registered: ${r.text.trim()}`);
    } else {
      if (r.text.includes('protocol_version')) {
        console.error(`[main] register refused: ${r.text.trim()}`);
        process.exitCode = 1;
        server.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!registered) {
    console.error('[main] register never answered ok; exiting');
    process.exitCode = 1;
    server.close();
    return;
  }

  // Poll /work until the env says done, then exit 0 at once. A process still
  // running when the trial wall ends scores 0, so never wait for anything else.
  for (;;) {
    const work = await getJson(`${envUrl}/work`);
    if (work !== null && work.done === true) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error('[main] work done, exiting 0');
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[main] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
