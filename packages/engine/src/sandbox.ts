// QuickJS sandbox — runs each column's JS body in an isolated WASM interpreter,
// exactly like Revcode. Host-side async work (HTTP, AI) is exposed through an
// asyncified bridge, so from the guest's perspective `sdk.<provider>.<method>(...)`
// is a normal *blocking* call that returns its result directly.
//
// Design note: asyncify can only suspend at the top-level eval entry, not inside
// a microtask. So sdk calls are synchronous and `await` is unnecessary. We strip
// any `async`/`await` the author writes (the sandbox exposes no other async
// primitive, so this is safe) — that keeps the familiar `await sdk.x.y()` style
// working while executing on the robust synchronous path.

import { newAsyncContext } from "quickjs-emscripten";

export type SandboxDispatch = (
  provider: string,
  method: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface RunFunctionOpts {
  /** Connector/user JS body, e.g. `function(inputs, sdk) { return sdk.ai.generate(...); }`. */
  code: string;
  inputs: Record<string, unknown>;
  /** provider -> method names. Materialises the `sdk` object inside the guest. */
  providers: Record<string, string[]>;
  dispatch: SandboxDispatch;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

/** Strip async/await — the sandbox's only async-looking primitive is the (blocking) sdk. */
export function normalizeCode(code: string): string {
  return code
    .replace(/\basync\s+function\b/g, "function")
    .replace(/\basync\s*\(/g, "(")
    .replace(/\basync\s+(?=[A-Za-z_$])/g, "") // async arrow w/ single param: `async x =>`
    .replace(/\bawait\s+/g, "");
}

function buildSdkPrelude(providers: Record<string, string[]>): string {
  let js = "globalThis.__sdk = Object.create(null);\n";
  for (const [provider, methods] of Object.entries(providers)) {
    js += `globalThis.__sdk[${JSON.stringify(provider)}] = Object.create(null);\n`;
    for (const method of methods) {
      js +=
        `globalThis.__sdk[${JSON.stringify(provider)}][${JSON.stringify(method)}] = ` +
        `function(input){ return JSON.parse(__hostCall(${JSON.stringify(provider)}, ${JSON.stringify(method)}, ` +
        `JSON.stringify(input === undefined ? {} : input))); };\n`;
    }
  }
  return js;
}

export async function runFunction(opts: RunFunctionOpts): Promise<unknown> {
  const { inputs, providers, dispatch, timeoutMs = 30_000, memoryLimitBytes = 128 * 1024 * 1024 } = opts;
  const code = normalizeCode(opts.code);
  const ctx = await newAsyncContext();

  // Surfaces a host-side error through the bridge so the guest throws normally.
  let pendingError: unknown = null;

  try {
    ctx.runtime.setMemoryLimit(memoryLimitBytes);
    const deadline = Date.now() + timeoutMs;
    ctx.runtime.setInterruptHandler(() => Date.now() > deadline);

    // Asyncified host bridge: __hostCall(provider, method, inputJson) -> resultJson.
    const hostFn = ctx.newAsyncifiedFunction("__hostCall", async (provH, methodH, inputH) => {
      const provider = ctx.getString(provH);
      const method = ctx.getString(methodH);
      const input = JSON.parse(ctx.getString(inputH) || "{}");
      try {
        const result = await dispatch(provider, method, input);
        return ctx.newString(JSON.stringify(result === undefined ? null : result));
      } catch (err) {
        // Stash and re-throw inside the guest as a real Error.
        pendingError = err;
        const msg = err instanceof Error ? err.message : String(err);
        return ctx.newString(JSON.stringify({ __hostError: msg }));
      }
    });
    ctx.setProp(ctx.global, "__hostCall", hostFn);
    hostFn.dispose();

    // Wrap each sdk method so a host error becomes a thrown Error in the guest.
    let prelude = buildSdkPrelude(providers);
    prelude += `
      (function(){
        for (const p of Object.keys(globalThis.__sdk)) {
          for (const m of Object.keys(globalThis.__sdk[p])) {
            const orig = globalThis.__sdk[p][m];
            globalThis.__sdk[p][m] = function(input){
              const r = orig(input);
              if (r && typeof r === "object" && typeof r.__hostError === "string") throw new Error(r.__hostError);
              return r;
            };
          }
        }
      })();`;
    ctx.unwrapResult(await ctx.evalCodeAsync(prelude)).dispose();

    // Run synchronously at the top-level eval entry, where asyncify can suspend safely.
    const runner = `JSON.stringify( ((${code}))(${JSON.stringify(inputs)}, globalThis.__sdk) ?? null )`;
    const res = await ctx.evalCodeAsync(runner);

    if (res.error) {
      const dumped = ctx.dump(res.error);
      res.error.dispose();
      if (pendingError instanceof Error) throw pendingError;
      const message =
        dumped && typeof dumped === "object" && "message" in dumped ? String((dumped as any).message) : String(dumped);
      throw new Error(`sandbox: ${message}`);
    }

    const json = ctx.getString(res.value);
    res.value.dispose();
    return JSON.parse(json);
  } finally {
    ctx.dispose();
  }
}
