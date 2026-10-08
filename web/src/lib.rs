use basedpl::{EvalOptions, Session};
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

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
pub struct BplSession { session: Session }

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
