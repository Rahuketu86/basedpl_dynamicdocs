#!/usr/bin/env bash
set -euo pipefail

REV="44352d9b63ef7532055f373c6cc32984430f71f5"
DEST="${1:-build/basedpl}"

rm -rf "$DEST"
git clone --quiet https://github.com/AnswerDotAI/basedpl.git "$DEST"
git -C "$DEST" checkout --quiet "$REV"

python3 - "$DEST/src/execution.rs" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

needle = "        self.countdown.set(CHECKS_PER_CLOCK - 1);\n        let now = Instant::now();\n"
replacement = """        self.countdown.set(CHECKS_PER_CLOCK - 1);
        if self.poll.is_none() && self.timeout.is_none() {
            if self.interrupt.0.load(Ordering::Relaxed) {
                return Err(span.error(ErrorKind::Interrupt, "evaluation interrupted"));
            }
            return Ok(());
        }
        let now = Instant::now();
"""
if text.count(needle) != 1:
    raise SystemExit(f"Expected timing pattern exactly once, found {text.count(needle)}")
path.write_text(text.replace(needle, replacement))
PY
