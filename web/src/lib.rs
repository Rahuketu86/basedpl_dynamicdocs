use basedpl::{Session, EvalOptions};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct BplSession { session: Session }

#[wasm_bindgen]
impl BplSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self { session: Session::new() } }

    pub fn diagnostic(&mut self, code: &str) -> String {
        let result = self.session.eval_with(code, EvalOptions::default());
        let output_len = result.output.len();
        let has_error = result.error.is_some();
        let has_value = result.value.is_some();
        format!("eval-completed output={} error={} value={}", output_len, has_error, has_value)
    }

    pub fn eval(&mut self, code: &str) -> JsValue {
        let result = self.session.eval_with(code, EvalOptions::default());
        let output = result.output.iter().map(|o| o.written()).collect::<String>();
        let error = result.error.as_ref().map(ToString::to_string);
        let value = result.value.as_ref().map(|v| self.session.show(v));
        serde_wasm_bindgen::to_value(&serde_json::json!({
            "output": output,
            "error": error,
            "value": value
        })).unwrap()
    }

    pub fn complete(&self, prefix: &str) -> JsValue {
        serde_wasm_bindgen::to_value(&self.session.complete(prefix)).unwrap()
    }
}
