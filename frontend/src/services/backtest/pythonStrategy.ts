// Compile a user-supplied Python source into a `Strategy` by running it inside
// Pyodide (CPython in WebAssembly). Everything runs in the browser — the user's
// code never leaves their machine, and arbitrary Python can't do anything more
// dangerous here than the page itself can (no `os` filesystem, no network
// beyond what Pyodide exposes).
//
// User contract:
//   def init(params: dict) -> Any:        # returns initial state
//   def on_trade(state, trade, params) -> "buy" | "sell" | "hold"
//
// `params` is whatever the user defined in the dashboard's parameters editor
// (always includes initialCash + positionSize). `trade` is a dict with the
// same keys as the JS HistoricalTrade type.

import type { Strategy, BacktestParams, BacktestSignal, HistoricalTrade } from './types';

// Pyodide's full type surface is enormous; we only need a sliver.
interface PyodideRuntime {
  runPython(code: string): unknown;
  globals: {
    set(name: string, value: unknown): void;
    get(name: string): unknown;
  };
  // PyProxy for objects coming back from Python.
  toPy(value: unknown): unknown;
}

interface PyProxy {
  toJs(opts?: { dict_converter?: (entries: Iterable<[string, unknown]>) => unknown }): unknown;
  destroy?: () => void;
}

declare global {
  interface Window {
    loadPyodide?: (opts?: { indexURL?: string }) => Promise<PyodideRuntime>;
  }
}

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

let runtimePromise: Promise<PyodideRuntime> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(tag);
  });
}

/** Lazy-load + cache the Pyodide runtime. ~10MB initial download. */
export function loadPyodideRuntime(): Promise<PyodideRuntime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (typeof window === 'undefined') {
      throw new Error('Pyodide can only run in the browser');
    }
    if (!window.loadPyodide) {
      await injectScript(`${PYODIDE_BASE}pyodide.js`);
    }
    if (!window.loadPyodide) {
      throw new Error('loadPyodide not available after script load');
    }
    const py = await window.loadPyodide({ indexURL: PYODIDE_BASE });
    // Wrapper class lives in the runtime; new strategies just instantiate it
    // with their source code. Keeping the wrapper Python-side avoids string
    // injection issues we'd hit if we built `exec(...)` calls in JS.
    py.runPython(WRAPPER_PY);
    return py;
  })();
  // If load fails, allow a retry on the next call.
  runtimePromise.catch(() => { runtimePromise = null; });
  return runtimePromise;
}

const WRAPPER_PY = `
import json

_ACTIONS = ('buy', 'sell', 'hold')
_TYPES = ('market', 'limit', 'ioc')

class _BacktestStrategy:
    def __init__(self, source: str):
        ns = {}
        exec(source, ns, ns)
        self.init_fn = ns.get('init')
        self.on_trade_fn = ns.get('on_trade')
        if not callable(self.init_fn):
            raise ValueError("Your script must define 'init(params)'")
        if not callable(self.on_trade_fn):
            raise ValueError("Your script must define 'on_trade(state, trade, params)'")
        self.state = None

    @staticmethod
    def _to_py(obj):
        # JS objects arrive as pyodide.ffi.JsProxy; user code expects real
        # Python dicts so 'params["window"]' / dict(params) / .get() all work.
        # Native dicts pass through unchanged.
        if hasattr(obj, 'to_py'):
            return obj.to_py()
        return obj

    def setup(self, params):
        self.state = self.init_fn(self._to_py(params))

    def step(self, trade, params):
        # Returns a JSON string {action, type, limit?} — strings marshal cleanly
        # across the Pyodide FFI; dicts don't.
        result = self.on_trade_fn(
            self.state, self._to_py(trade), self._to_py(params),
        )
        return json.dumps(self._order(result))

    @staticmethod
    def _order(result):
        if result is None:
            return {'action': 'hold'}
        if isinstance(result, str):
            a = result.lower()
            if a not in _ACTIONS:
                raise ValueError(f"on_trade must return 'buy'/'sell'/'hold' or an order dict, got {result!r}")
            return {'action': a}
        if isinstance(result, dict):
            a = str(result.get('action', 'hold')).lower()
            if a not in _ACTIONS:
                raise ValueError(f"order 'action' must be buy/sell/hold, got {result.get('action')!r}")
            t = str(result.get('type', 'market')).lower()
            if t not in _TYPES:
                raise ValueError(f"order 'type' must be market/limit/ioc, got {result.get('type')!r}")
            out = {'action': a, 'type': t}
            if t in ('limit', 'ioc'):
                lim = result.get('limit')
                if lim is None:
                    raise ValueError(f"a '{t}' order requires a numeric 'limit' price")
                out['limit'] = float(lim)
            return out
        raise ValueError(f"on_trade returned unexpected value: {result!r}")
`;

/** Compile a user-supplied Python source into a Strategy. */
export async function compilePythonStrategy(source: string, displayName = 'Custom (Python)'): Promise<Strategy> {
  const py = await loadPyodideRuntime();

  // Hand the source to Python via globals to avoid escaping nightmares.
  py.globals.set('_user_source', source);
  let wrapper: PyProxy;
  try {
    wrapper = py.runPython('_BacktestStrategy(_user_source)') as PyProxy;
  } catch (e) {
    throw new Error(`Python compile failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Per-instance state lives in the wrapper Python object, NOT in `state` we
  // pass back. The Strategy.init() return value is just a sentinel — we ignore
  // it on the JS side and treat `wrapper` as the live state owner. This avoids
  // having to ferry Python state objects across the FFI boundary every tick.
  const strategy: Strategy<{ wrapper: PyProxy }> = {
    id: 'custom_python',
    name: displayName,
    description: 'User-supplied Python strategy. Runs in-browser via Pyodide.',
    init(p: BacktestParams) {
      try {
        // Cast to bypass the unknown-arg signature; Pyodide auto-converts
        // plain JS objects to Python dicts when a function is called.
        (wrapper as unknown as { setup: (p: BacktestParams) => void }).setup(p);
      } catch (e) {
        throw new Error(`init() raised: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { wrapper };
    },
    onTrade(_state, trade: HistoricalTrade, p: BacktestParams): BacktestSignal {
      try {
        const raw = (wrapper as unknown as {
          step: (t: HistoricalTrade, p: BacktestParams) => string;
        }).step(trade, p);
        // step() returns JSON {action, type, limit?}.
        const sig = JSON.parse(raw) as { action?: string; type?: string; limit?: number };
        const action: BacktestSignal['action'] =
          sig.action === 'buy' || sig.action === 'sell' ? sig.action : 'hold';
        const type: BacktestSignal['type'] =
          sig.type === 'limit' || sig.type === 'ioc' ? sig.type : 'market';
        return { action, type, limit: sig.limit };
      } catch (e) {
        throw new Error(`on_trade() raised at ts=${trade.ts}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
  return strategy as Strategy;
}

export const EXAMPLE_PY = `# Example: SMA-cross showing the three order types.
#
# on_trade may return any of:
#   "buy" / "sell" / "hold"                              -> market order
#   {"action": "buy",  "type": "market"}                 -> market (explicit)
#   {"action": "buy",  "type": "limit", "limit": price}  -> rest a limit @ price
#   {"action": "sell", "type": "ioc",   "limit": price}  -> immediate-or-cancel
#
# market = cross the spread now (buy@ask / sell@bid).
# limit  = rest; fills later when price crosses your limit (filled at the limit).
# ioc    = fill now if marketable at your limit, else cancel.
#
# Params (all numeric, edited below):
#   window            SMA length in ticks
#   threshold_bps     how far past the SMA counts as a signal
#   entry_offset_bps  how far BELOW price to rest the buy limit (passive entry)
#   exit_mode         0 = market exit, 1 = IOC exit at the current price

def init(params):
    return {"history": []}

def on_trade(state, trade, params):
    window = int(params.get("window", 20))
    threshold = params.get("threshold_bps", 5) / 10_000.0
    entry_off = params.get("entry_offset_bps", 3) / 10_000.0
    exit_mode = int(params.get("exit_mode", 0))

    px = trade["price"]
    hist = state["history"]
    hist.append(px)
    if len(hist) > window:
        hist.pop(0)
    if len(hist) < window:
        return "hold"

    sma = sum(hist) / len(hist)

    # Uptrend: enter passively with a resting BUY LIMIT just below price.
    if px > sma * (1 + threshold):
        return {"action": "buy", "type": "limit", "limit": px * (1 - entry_off)}

    # Downtrend: exit. Market by default, or IOC at the current price.
    if px < sma * (1 - threshold):
        if exit_mode == 1:
            return {"action": "sell", "type": "ioc", "limit": px}
        return {"action": "sell", "type": "market"}

    return "hold"
`;

// Mirrors EXAMPLE_PY's parameter usage so "Load example" can seed the
// dashboard's Parameters editor in one click.
export const EXAMPLE_PARAMS: Array<{ key: string; label: string; value: number }> = [
  { key: 'window',           label: 'SMA window (ticks)',       value: 20 },
  { key: 'threshold_bps',    label: 'Threshold (bps)',          value: 5  },
  { key: 'entry_offset_bps', label: 'Limit entry offset (bps)', value: 3  },
  { key: 'exit_mode',        label: 'Exit: 0=market 1=IOC',     value: 0  },
];
