# Made with Uncensia

[简体中文](README.zh-CN.md) · [Project overview](../../../README.md) · [Creative guide](../guide.en.md)

## Baker Street: one character across three shots

On 2026-09-14, three watercolor-cinematic scenes of Sherlock Holmes and Dr. Watson (public-domain characters) were produced through the same Siray Seedream 5.0 Pro Spicy models Uncensia’s generation adapter drives: one text-to-image job, then two image-to-image edits that both take the **first** image as their source.

| Step | Backend | Output |
|---|---|---|
| Establish the study | Siray · Seedream 5.0 Pro T2I | [221B Baker Street](sherlock-01-study.png) |
| Re-shoot the moment | Siray · Seedream 5.0 Pro I2I (source: scene 1) | [Holmes with the magnifier](sherlock-02-clue.png) |
| Carry them into a new scene | Siray · Seedream 5.0 Pro I2I (source: scene 1) | [Out into the fog](sherlock-03-street.png) |

Both edits branch from the first image, not from each other, so the two men stay recognisable while the pose, framing and setting change. Style and faces carry across the sequence; small details still vary — visual continuity is consistency, not pixel identity. [Submitted prompts, model IDs, task IDs and SHA-256 hashes](sherlock-manifest.json).

## A companion, and a compose

On 2026-09-14, an original fictional character (no private user data) was created and then kept across settings, and two separate portraits were combined into one scene — all through the same Siray Seedream 5.0 Pro Spicy models.

| Step | Op | Output |
|---|---|---|
| Design the character | text-to-image | [Rainy café](companion-01-cafe.png) |
| Same person, new mood | image-to-image (source: café) | [Neon night street](companion-02-night.png) |
| Same person, at home | image-to-image (source: café) | [Evening at home](companion-03-home.png) |
| A second character | text-to-image | [Portrait B](compose-b-friend.png) |
| **Compose two references into one scene** | image-to-image (sources: café **and** Portrait B) | [Both on a bench](compose-result.png) |

The two moods branch from the first café portrait, keeping her face, freckles and star necklace. The final image is one image-to-image job given **two** reference images at once, so both faces are carried into a new scene — the multi-image compose Uncensia exposes as "使用固定的图片参考" / additional sources. [Submitted prompts, model IDs, task IDs and SHA-256 hashes](companion-manifest.json).

## Wonderland: read, illustrate, revise

On 2026-09-13, a separate local Uncensia instance imported the English text of [Alice’s Adventures in Wonderland](https://www.gutenberg.org/ebooks/11). The agent located Chapter VII, then submitted three watercolor scenes through the real generation queue: one text-to-image job and two edits using the first result as their source.

The chat model was DeepSeek V4 Flash through Siray. Images used Seedream 5.0 Pro T2I / I2I through Siray, at 1248 × 832. This is a documented creative example, not a benchmark or a claim that every prompt works in one pass.

| Scene | Output |
|---|---|
| Tea table | [Original image](alice-01-tea-table.png) |
| Pocket watch | [Illustration](alice-02-pocket-watch.png) |
| Alice leaving | [Original image](alice-03-leaving.png) |

[Submitted generation parameters, source IDs and output hashes](alice-manifest.json). IDs identify resources in this demonstration only; select your own generated resources when reproducing it.

The initial chat provider returned insufficient balance. After explicitly selecting Siray for the demo, the agent needed a correction to locate the chapter with its exact file ID. The first media attempt exposed missing T2I support in the adapter; generation continued after that support was added. No failed attempt is presented as a successful render.

The original watch image combined two moments into two watches. A follow-up requested a local correction to that image only. The first and third scenes were retained. Style and characters are recognizable across the sequence, but small details vary; visual continuity is not exact pixel identity.

The watch correction succeeded: the revised illustration contains one watch held near the Hatter’s ear. The [first version](alice-02-pocket-watch-v1.png) remains available for comparison. A new conversation then reused the three final images in an illustrated adaptation with a clearly marked original continuation; that writing pass generated no additional images.

## Real client captures

- [Web illustrated story](web-alice-story.jpg) · [native iOS](ios-alice-story.zh-CN.jpg): the same final images embedded between story passages.

- [Web roleplay](web-roleplay.zh-CN.jpg): an actual generated opening as the Hatter, leaving the traveler’s response to the user.
- [Story settings](web-story-settings.zh-CN.jpg): saved optional character, identity, world and scene fields in the Web client.
- [Native iOS roleplay](ios-roleplay.zh-CN.jpg): the same conversation on the SwiftUI client in iPhone 17 Pro Simulator.

These are application captures, not interface mockups. The isolated instance contains public book text and new demo creations. The Web story capture has English UI labels; the story content and native captures are Chinese. The prompts in the creative guide are reusable examples, not a verbatim transcript of every correction in this run.

## A character, two locations, one moving shot

The fictional woman in a yellow raincoat was created for this public showcase on 2026-09-08. No private user conversations, memories, reference photos, or existing creations were used.

| Step | Actual backend | Output |
|---|---|---|
| Create the station portrait | ComfyUI · Lustify V10 Krea Turbo | 1536 × 1024 PNG |
| Move the character to the coast | Siray · Seedream 5.0 Pro image-to-image | 1248 × 832 PNG |
| Animate the station portrait | Siray · Wan 3.0 image-to-video | 1280 × 720 MP4, 4 seconds, silent |

![Station portrait](01-midnight-platform.png)

![Coastal edit](02-coastal-morning.png)

![Animated preview](03-departure.gif)

[Original video](03-departure.mp4) · [Exact submitted parameters](manifest.json)

## Reproduce it

Configure the corresponding models in Uncensia. For the first image, the packaged ComfyUI workflow needs `lustify_v10_krea_turbo_int8_convrot.safetensors`, `qwen3vl_4b_fp8_scaled.safetensors`, and `wan_2.1_vae.safetensors`, plus the node types declared in the workflow. It uses 8 steps, CFG 1, Euler, beta, and shift 4. The image seed was `9082026`.

1. In Studio, choose image generation and the Lustify model. Copy the first entry’s prompt and dimensions from the manifest.
2. Choose image editing and Seedream. Select the first image as the source; use the second entry’s prompt and `1248x832` size.
3. Choose Wan image-to-video. Use the **station image**, not the coastal edit, as the first frame. Use the final entry’s prompt, 4 seconds, 720p, 16:9, no audio, and no provider prompt expansion.

The asset IDs in the manifest belong to this isolated demo installation; select the equivalent newly generated source in your own installation. Cloud runs may cost money. Provider updates and stochastic generation mean a repeat may differ even with the same settings.

These jobs were submitted through Uncensia’s actual job queue and adapters in an isolated data directory. Both image files were visually inspected; the MP4’s dimensions/duration and representative frames were checked. The edit retains the recognizable hair, coat, scarf, and photographic style, while changing pose and scenery. This is an example, not a benchmark proving identity fidelity across all poses.

The GIF is a smaller animated preview of the MP4. Source images and the original returned MP4 are included separately. The manifest contains public prompts and parameters only; no credentials or provider download URLs.

## Web UI screenshots

`web-studio.png`, `web-studio.zh-CN.png`, and `web-edit.zh-CN.png` are actual Uncensia browser captures from the isolated demo installation, showing the three creations above. Prompt fields illustrate the workflow; capturing them did not submit additional generation jobs. The instance contains no private conversations, and cloud credentials were removed after generation.
