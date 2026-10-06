#!/usr/bin/env bash
set -euo pipefail

REV="44352d9b63ef7532055f373c6cc32984430f71f5"
DEST="${1:-build/basedpl}"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"

git clone --quiet https://github.com/AnswerDotAI/basedpl.git "$DEST"
git -C "$DEST" checkout --quiet "$REV"

python3 - "$DEST/src/execution.rs" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

old = """        self.countdown.set(CHECKS_PER_CLOCK - 1);
        let now = Instant::now();
        if let Some((poll, last)) = &self.poll {
"""

new = """        self.countdown.set(CHECKS_PER_CLOCK - 1);
        if self.poll.is_none() && self.timeout.is_none() {
            if self.interrupt.0.load(Ordering::Relaxed) {
                return Err(span.error(ErrorKind::Interrupt, "evaluation interrupted"));
            }
            return Ok(());
        }
        let now = Instant::now();
        if let Some((poll, last)) = &self.poll {
"""

if text.count(old) != 1:
    raise SystemExit("Expected BasedPL execution.rs pattern was not found exactly once")

path.write_text(text.replace(old, new))
PY

echo "Prepared BasedPL $REV with browser-safe default evaluation timing"
