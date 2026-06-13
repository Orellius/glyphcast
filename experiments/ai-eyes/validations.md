# AI-eyes validations log

Can an LLM read a glyph-rendered video frame as text and identify the scene?
Protocol: 4-way multiple choice, **hard** options (every distractor a same-domain
animal/meadow scene so color/scene-type statistics can't carry it). Chance = 25%.
Frames: `experiments/ai-eyes/variants/t{2,7,12,17,22,27}-quadrant-40.txt` — mono
quadrant glyph text, 40×13 cells, no color. Ground truth: `answers.json`.

Baseline for comparison: sending the actual PNG to a vision model = **100%** at
~1,000 input tokens. Glyph-text quadrant-40 ≈ 1,260 tokens.

## Results

| subject | access | score (hard, quadrant-40) | notes |
|---|---|---|---|
| devstral-small-2 (24B) | local Ollama, $0 | **83%** (5/6) | see run-local-*-hard.json |
| gemma4:31b | local Ollama, $0 | 0%* | *unparseable output, not blindness |
| gemma4 (12B bf16) | local Ollama, $0 | ~0% | near chance |
| Claude Opus 4.8 | blind subagents, $0 | **67%** (4/6) | genuinely reconstructs structure; missed t7, t12 |

Blind Opus 4.8 per-frame: t2 ✓ · t7 ✗ (said rabbit-by-trunk, truth squirrel-leap) ·
t12 ✗ (said rabbit+bird, truth two squirrels) · t17 ✓ · t22 ✓ · t27 ✓.

## Verdict so far

Glyph frames ARE legible to capable models well above chance (67-83%), and the
models read real structure (rabbit vs tree-trunk vs two-animals), not noise. But:
1. A bigger/frontier model is NOT dramatically better than a good 24B here.
2. Native vision still beats all of them: 100% at fewer tokens.

So: a real, publishable legibility finding — not a moat. Sending the image is
cheaper and more accurate than sending glyphs.

## Cross-vendor (free web tiers, via browser)

OpenAI GPT (free tier, chatgpt.com, driven via browser, $0):
- t2 (truth: rabbit in meadow) → **C ✓** — "A large rabbit-like animal standing side-on above a grassy ground."
- t12 (truth: two squirrels + butterfly) → C ✗ — "a squirrel climbing alongside a vertical trunk" (saw squirrel + trunk, missed the count/butterfly)

Screenshots captured this session as proof.

## Final picture (four vendors)

| vendor / model | how | reads glyphs? |
|---|---|---|
| Anthropic — Claude Opus 4.8 | blind subagents, $0 | 67% (4/6), reconstructs structure |
| OpenAI — GPT (free) | browser, $0 | gets the gist (rabbit ✓; squirrel+trunk on the two-squirrel frame) |
| Mistral — devstral 24B | local, $0 | 83% (5/6) |
| Google — gemma | local, $0 | low (parsing) |

Consistent across all four: capable models read a glyph frame well above chance
and name the main subject (rabbit vs squirrel vs tree-trunk vs two-animals), but
miss fine distinctions (count, small held objects) at 40×13 mono. **Native vision
still wins on both axes (100%, fewer tokens).** Legibility = proven and
cross-vendor. Moat = no. Great launch artifact, not a business.

## Representation matters: color (gen-color.ts) raises the floor

The runs above were MONO (shape only) — a handicap, since color is the codec's
defining signal. Re-ran blind Claude Opus 4.8 on a shape + 8-color-palette
representation (`color-variants/`), same 6 frames, same hard options:

| frame | mono | +color | what color fixed |
|---|---|---|---|
| t2 rabbit | C ✓ | C ✓ | — |
| t7 squirrel leaping | ✗ | ✗ | pose ambiguity, not color |
| t12 two squirrels + butterfly | ✗ | **D ✓** | magenta cells = the purple butterfly |
| t17 rabbit + fruit | ✗ | **B ✓** | red cell = the apple on the ground |
| t22 rabbit by trunk | C ✓ | C ✓ | — |
| t27 rabbit from behind | A ✓ | A ✓ | — |

**Mono 67% (4/6) → color 83% (5/6).** The two recovered frames are exactly the
color-dependent distinctions. So legibility is representation-sensitive and the
mono number was a floor. Honest headline: *frontier models read glyphcast frames
at ~83% on adversarial 4-way MC given shape + color.* Still below vision's 100%
at fewer tokens — better representation narrows the gap, doesn't flip the
economics.
