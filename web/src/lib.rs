use basedpl::{EvalOptions, Poll, Session, Turn};
use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

thread_local! {
    /// The host's interrupt flag, if it gave one (see `set_interrupt`). It lives here, not in the poll closure, because a
    /// `Poll` must be `Send + Sync` and a JavaScript array isn't.
    static INTERRUPT: RefCell<Option<js_sys::Int32Array>> = const { RefCell::new(None) };
}

/// Lets the host interrupt a running `eval` through shared memory: while `flag[0]` is 1, the evaluation stops with an
/// interrupt error. memexsolvelite's language protocol (web/msl-worker.mjs) passes its `Int32Array` over the
/// `SharedArrayBuffer` it sends in `init`. Without a flag, `eval` checks nothing, as before.
#[wasm_bindgen]
pub fn set_interrupt(flag: Option<js_sys::Int32Array>) { INTERRUPT.set(flag); }

/// A poll that reports the host's interrupt flag, when there is one. BasedPL calls it at most every 10 ms.
fn interrupt_poll() -> Option<Poll> {
    INTERRUPT.with_borrow(Option::is_some).then(|| {
        Arc::new(|| INTERRUPT.with_borrow(|flag| flag.as_ref().is_some_and(|f| js_sys::Atomics::load(f, 0) == Ok(1)))) as Poll
    })
}

/// Sets the URL that relative paths resolve against for `•nget`/`•nput`/`•load`.
/// Without this, those read/write against an empty base and simply error.
#[wasm_bindgen]
pub fn configure(base: String) { basedpl::configure_browser(base); }

/// Every glyph's row (name, monad, dyad, aliases, and its precomputed Option-chord
/// `shortcut`), as JSON text -- the same data upstream's own WASM package exposes
/// to feed the vendored `lb.js`/`input.js` keyboard and completion engine. Called
/// once at worker-ready, not per keystroke: see jupyterlite/README.md.
#[wasm_bindgen]
pub fn symbols() -> String { basedpl::symbols::rows().to_string() }

#[wasm_bindgen]
// As of BasedPL 0.1.81 a process has one session; `Session::new()` hands out a `Turn` at it (cleared, as a new session
// starts), which dereferences to the session.
pub struct BplSession { session: Turn }

#[wasm_bindgen]
impl BplSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self { session: Session::new() } }

    pub fn diagnostic(&mut self, code: &str) -> String {
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let output = Arc::new(Mutex::new(String::new()));
        let events_sink = events.clone();
        let output_sink = output.clone();
        let sink = Arc::new(move |event: &basedpl::Output| {
            events_sink.lock().unwrap().push(basedpl::protocol::output(event));
            output_sink.lock().unwrap().push_str(&event.written());
        });
        let result = self.session.eval_with(code, EvalOptions {
            output: Some(sink),
            ..EvalOptions::default()
        });
        let event_count = events.lock().unwrap().len();
        let output_len = output.lock().unwrap().len();
        let has_error = result.error.is_some();
        let has_value = result.value.is_some();
        format!("eval-completed events={} output={} error={} value={}", event_count, output_len, has_error, has_value)
    }

    pub fn eval(&mut self, code: &str) -> String {
        // Follow BasedPL's own Jupyter kernel: capture Output events rather than
        // relying only on Evaluation.value. Implicit expression results are
        // emitted as OutputKind::Display when echo=true.
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let output = Arc::new(Mutex::new(String::new()));
        let events_sink = events.clone();
        let output_sink = output.clone();
        let sink = Arc::new(move |event: &basedpl::Output| {
            events_sink.lock().unwrap().push(basedpl::protocol::output(event));
            output_sink.lock().unwrap().push_str(&event.written());
        });

        let result = self.session.eval_with(code, EvalOptions {
            output: Some(sink),
            poll: interrupt_poll(),
            ..EvalOptions::default()
        });

        let error = result.error.as_ref().map(ToString::to_string);
        let value = result.value.as_ref().map(|v| self.session.show(v));
        let output = output.lock().unwrap().clone();
        let events = events.lock().unwrap().clone();

        // Return JSON text rather than a JsValue object. This is intentionally
        // boring: the wasm-bindgen Node and browser targets both receive the
        // exact same wire representation, and the Worker can JSON.parse it.
        serde_json::to_string(&serde_json::json!({
            "output": output,
            "events": events,
            "error": error,
            "value": value
        })).unwrap()
    }

    pub fn complete(&self, prefix: &str) -> JsValue {
        serde_wasm_bindgen::to_value(&self.session.complete(prefix)).unwrap()
    }

    pub fn complete_glyphs(&self, prefix: &str) -> JsValue {
        let matches = basedpl::symbols::matches(prefix)
            .into_iter()
            .map(|(glyph, _)| glyph)
            .collect::<Vec<_>>();
        serde_wasm_bindgen::to_value(&matches).unwrap()
    }
}
