/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compatibility shim for the Prompt API's Origin Trial era namespaces.
 *
 * Before the `LanguageModel` global shipped, Chrome exposed the same API as
 * `chrome.aiOriginTrial.languageModel` in extension contexts and as
 * `window.ai.languageModel` on the web. On a browser that has one of those
 * but no global, this module finds the legacy factory and installs a facade
 * as `globalThis.LanguageModel`, so `easy-language-model` and the on-device
 * backend keep working unchanged. The extension namespace is checked first:
 * the side panel is an extension context, where `chrome.aiOriginTrial` is the
 * namespace the trial was published under.
 *
 * The facade absorbs what changed between the eras:
 *
 * - Where `availability()` now answers `'unavailable' | 'downloadable' |
 *   'downloading' | 'available'`, the old `capabilities()` answered
 *   `available: 'no' | 'readily' | 'after-download'` (and carried the numbers
 *   `params()` reports).
 * - Where `create()` now takes the system prompt as a `role: 'system'` entry
 *   of `initialPrompts`, the old signature took a `systemPrompt` option and
 *   rejected `initialPrompts` with a `TypeError` or `NotSupportedError`. Only
 *   on that failure is the call retried with the option it understands.
 * - Sessions measured the context through `inputUsage`/`inputQuota`, earlier
 *   still `tokensSoFar`/`maxTokens`, where they now use `contextUsage`/
 *   `contextWindow`. A proxy answers the new names from whichever the session
 *   has; every other member is passed straight through, with methods bound to
 *   the session itself so native ones keep their receiver.
 *
 * An existing `LanguageModel` is never overwritten: a native build, and the
 * stubs tests install, always win. The legacy interfaces live here as local
 * types only, so they cannot collide with the ambient declarations of
 * `@types/dom-chromium-ai` or `@types/chrome`.
 */

/**
 * A legacy namespace's factory. Only `create` is required for the namespace
 * to count as a Prompt API at all; the rest is probed at call time, so one
 * type covers both the near-mirror namespaces and the `capabilities()`-era
 * shape. Methods return `unknown`: their answers are guarded where read.
 */
interface LegacyLanguageModelFactory {
  create(options?: Record<string, unknown>): unknown;
  availability?(options?: Record<string, unknown>): unknown;
  capabilities?(options?: Record<string, unknown>): unknown;
  params?(): unknown;
}

/** What the facade puts on `globalThis.LanguageModel`. */
interface LanguageModelFacade {
  availability(options?: Record<string, unknown>): Promise<Availability>;
  create(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  params(): Promise<Partial<LanguageModelParams> | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isAvailability(value: unknown): value is Availability {
  return value === 'unavailable' || value === 'downloadable' || value === 'downloading' || value === 'available';
}

function isLegacyFactory(value: unknown): value is LegacyLanguageModelFactory {
  return isRecord(value) && typeof value.create === 'function';
}

/**
 * The first usable legacy factory, in detection order:
 * `chrome.aiOriginTrial.languageModel`, then `window.ai.languageModel`.
 */
function detectLegacyFactory(): LegacyLanguageModelFactory | null {
  const root = globalThis as Record<string, unknown>;
  const chrome = isRecord(root.chrome) ? root.chrome : null;
  const originTrial = chrome && isRecord(chrome.aiOriginTrial) ? chrome.aiOriginTrial : null;
  if (originTrial && isLegacyFactory(originTrial.languageModel)) {
    return originTrial.languageModel;
  }
  const ai = isRecord(root.ai) ? root.ai : null;
  if (ai && isLegacyFactory(ai.languageModel)) {
    return ai.languageModel;
  }
  return null;
}

/** The `available` answer of the old `capabilities()`, in today's words. */
function mapLegacyAvailability(available: unknown): Availability {
  switch (available) {
    case 'no':
      return 'unavailable';
    case 'readily':
      return 'available';
    case 'after-download':
      return 'downloadable';
    default:
      return isAvailability(available) ? available : 'unavailable';
  }
}

/**
 * The `capabilities()` answer of the Origin Trial era, which doubled as what
 * `params()` reports now: `available`, and the `defaultTopK`/`maxTopK`/
 * `defaultTemperature`/`maxTemperature` numbers where a build reports them.
 */
async function legacyCapabilities(factory: LegacyLanguageModelFactory, options?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (typeof factory.capabilities !== 'function') return null;
  const capabilities = await factory.capabilities(options);
  return isRecord(capabilities) ? capabilities : null;
}

async function legacyAvailability(factory: LegacyLanguageModelFactory, options?: Record<string, unknown>): Promise<Availability> {
  if (typeof factory.availability === 'function') {
    const availability = await factory.availability(options);
    return isAvailability(availability) ? availability : 'unavailable';
  }
  return mapLegacyAvailability((await legacyCapabilities(factory, options))?.available);
}

/** A number field of `capabilities()`, when the build reported one. */
function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

async function legacyParams(factory: LegacyLanguageModelFactory): Promise<Partial<LanguageModelParams> | undefined> {
  if (typeof factory.params === 'function') {
    const params = await factory.params();
    return isRecord(params) ? params : undefined;
  }
  const capabilities = await legacyCapabilities(factory);
  if (!capabilities) return undefined;
  return {
    defaultTopK: numberField(capabilities, 'defaultTopK'),
    maxTopK: numberField(capabilities, 'maxTopK'),
    defaultTemperature: numberField(capabilities, 'defaultTemperature'),
    maxTemperature: numberField(capabilities, 'maxTemperature'),
  };
}

/** The text of a prompt message's content, string or `type: 'text'` parts. */
function promptContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && part.type === 'text' ? String(part.value ?? '') : '')).join('');
  }
  return content == null ? '' : String(content);
}

/**
 * Whether a rejected `create()` is worth the one retry the old signature
 * allows: it rejected `initialPrompts` as an unknown option, reported as a
 * `TypeError` or a `NotSupportedError` DOMException. Every other failure is
 * the caller's to see.
 */
function isOldSignatureRejection(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (isRecord(error) && (error.name === 'TypeError' || error.name === 'NotSupportedError'))
  );
}

/**
 * `options` rewritten for a `create()` that knows `systemPrompt` instead of
 * `initialPrompts`: the `role: 'system'` messages move to the option, the
 * rest stays. `null` when there is no system prompt to move, which is the
 * only thing the rewrite changes.
 */
function legacyCreateRetryOptions(options: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(options.initialPrompts)) return null;
  const system = options.initialPrompts.filter((prompt) => isRecord(prompt) && prompt.role === 'system');
  if (system.length === 0) return null;
  const rest = options.initialPrompts.filter((prompt) => !(isRecord(prompt) && prompt.role === 'system'));
  const texts = system.map((prompt) => promptContentText(isRecord(prompt) ? prompt.content : prompt));
  if (typeof options.systemPrompt === 'string') texts.unshift(options.systemPrompt);
  return { ...options, systemPrompt: texts.join('\n'), initialPrompts: rest };
}

/**
 * A session that answers `contextUsage`/`contextWindow` from whatever names
 * the legacy session actually has, and passes everything else through. The
 * methods are bound to the raw session so a native one keeps its receiver.
 */
function normalizeSession(session: unknown): Record<string, unknown> {
  if (!isRecord(session)) {
    throw new TypeError('The legacy Prompt API returned an invalid session.');
  }
  return new Proxy(session, {
    get(target, prop) {
      if (prop === 'contextUsage') {
        return target.contextUsage ?? target.inputUsage ?? target.tokensSoFar;
      }
      if (prop === 'contextWindow') {
        return target.contextWindow ?? target.inputQuota ?? target.maxTokens;
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
}

async function legacyCreate(factory: LegacyLanguageModelFactory, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return normalizeSession(await factory.create(options));
  } catch (error) {
    if (!isOldSignatureRejection(error)) throw error;
    const retryOptions = legacyCreateRetryOptions(options ?? {});
    if (!retryOptions) throw error;
    return normalizeSession(await factory.create(retryOptions));
  }
}

/** The `LanguageModel` static surface, built on the legacy `factory`. */
function createFacade(factory: LegacyLanguageModelFactory): LanguageModelFacade {
  return {
    availability: (options) => legacyAvailability(factory, options),
    create: (options) => legacyCreate(factory, options),
    params: () => legacyParams(factory),
  };
}

/** The facade this module installed, or `null`. Identity is the marker. */
let shim: LanguageModelFacade | null = null;

/**
 * Whether the `LanguageModel` in `globalThis` is this module's facade rather
 * than a native implementation, which decides the degradations the backend
 * may apply: a legacy session cannot be assumed to understand tool calling.
 */
export function isLegacyPromptApi(): boolean {
  return shim !== null && (globalThis as Record<string, unknown>).LanguageModel === shim;
}

/**
 * Installs the facade as `globalThis.LanguageModel` when a legacy namespace
 * is the only Prompt API the browser has. Idempotent: an existing
 * `LanguageModel` — native, a test stub, or this shim — is never overwritten,
 * and a call made after the globals changed simply re-detects.
 */
export function ensurePromptApiShim(): void {
  const root = globalThis as Record<string, unknown>;
  if ('LanguageModel' in root) return;
  const factory = detectLegacyFactory();
  if (!factory) return;
  const facade = createFacade(factory);
  root.LanguageModel = facade as unknown as typeof LanguageModel;
  shim = facade;
}

// Apply the shim at module evaluation as well: imported before
// `easy-language-model`, it puts the global in place early enough for a
// wrapper that captured it eagerly, while the lazy call through
// `isPromptApiSupported()` still catches a namespace stubbed in later. A shim
// that failed to install must never break the importing module.
try {
  ensurePromptApiShim();
} catch {}
