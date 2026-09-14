<div align="center">
<img src="uncensia/src/web/assets/uncensia.svg" alt="Uncensia" width="72" />

# Uncensia

**Your own AI studio — chat, an agent that uses tools, file memory, and image/video creation — self-hosted, unrestricted, and driven by your own models.**

It’s the ChatGPT-app experience you already like — conversation, an agent, uploads, memory, and generation — but it runs on *your* server and *your* phone, uses *your* API keys and local GPU, and has no app-level content filter.

![Self-hosted](https://img.shields.io/badge/self--hosted-single%20user-111827)
![Web + native iOS](https://img.shields.io/badge/clients-Web%20%2B%20native%20iOS-1f6feb)
![Bring your own models](https://img.shields.io/badge/models-bring%20your%20own-16a34a)
![No app-level filter](https://img.shields.io/badge/content-no%20app--level%20filter-7c3aed)

[简体中文](README.zh-CN.md) · [Quick start](#quick-start) · [Creative guide](uncensia/docs/guide.en.md) · [Documentation](uncensia/docs/README.en.md) · [How these were made](uncensia/docs/showcase/README.md)

</div>

---

Everything below is a **real output** from Uncensia’s own pipeline — same models, same job queue you get out of the box — with prompts, model IDs and SHA-256 hashes in [the production notes](uncensia/docs/showcase/README.md). Nothing here is a mockup, and no failed attempt is dressed up as a success.

<table>
<tr>
<td width="25%"><img src="uncensia/docs/showcase/alice-01-tea-table.png" alt="Storybook watercolour" /></td>
<td width="25%"><img src="uncensia/docs/showcase/sherlock-03-street.png" alt="Victorian oil painting" /></td>
<td width="25%"><img src="uncensia/docs/showcase/02-coastal-morning.png" alt="Photoreal film still" /></td>
<td width="25%"><img src="uncensia/docs/showcase/companion-01-cafe.png" alt="Soft anime illustration" /></td>
</tr>
<tr>
<td align="center">Storybook watercolour</td>
<td align="center">Victorian oil</td>
<td align="center">Photoreal film</td>
<td align="center">Soft anime</td>
</tr>
</table>

<p align="center"><i>One product, your models, any style — every image on this page was generated in Uncensia.</i></p>

## Keep one character across scene after scene

A single text-to-image job establishes the scene, then two *edits of that first image* move the moment and change the setting — while Holmes and Watson stay recognisably themselves. This “visual continuity” is the hard part of illustrating anything longer than one picture, and it’s built into the conversation.

<table>
<tr>
<td width="33%"><img src="uncensia/docs/showcase/sherlock-01-study.png" alt="221B Baker Street, text-to-image" /></td>
<td width="33%"><img src="uncensia/docs/showcase/sherlock-02-clue.png" alt="Edit of the first image: same room, new pose" /></td>
<td width="33%"><img src="uncensia/docs/showcase/sherlock-03-street.png" alt="Edit of the first image: the characters carried into a new scene" /></td>
</tr>
<tr>
<td><b>1.</b> Text-to-image: 221B Baker Street.</td>
<td><b>2.</b> Edit the first image — same room, Holmes rises with the magnifier.</td>
<td><b>3.</b> Edit again — same two men, out into a foggy Baker Street.</td>
</tr>
</table>

## Meet a companion — the same person, wherever the story goes

Design a character once, then keep them across moods, outfits and settings. One portrait, then two edits of it: her face, freckles and little star necklace carry from a rainy café to a neon street to a quiet evening at home.

<table>
<tr>
<td width="33%"><img src="uncensia/docs/showcase/companion-01-cafe.png" alt="Companion character, café" /></td>
<td width="33%"><img src="uncensia/docs/showcase/companion-02-night.png" alt="Same character, rainy neon street" /></td>
<td width="33%"><img src="uncensia/docs/showcase/companion-03-home.png" alt="Same character, cozy at home" /></td>
</tr>
<tr>
<td>A rainy afternoon café.</td>
<td>Same person, a neon night out.</td>
<td>Same person, home for the evening.</td>
</tr>
</table>

## Bring two characters into one scene

Compose is more than editing one picture: hand the model **several** reference images and it builds a new scene from all of them. Here two separate portraits become one — each face kept — sitting together on an autumn bench.

<table>
<tr>
<td width="25%"><img src="uncensia/docs/showcase/companion-01-cafe.png" alt="Reference A" /></td>
<td width="25%"><img src="uncensia/docs/showcase/compose-b-friend.png" alt="Reference B" /></td>
<td width="50%"><img src="uncensia/docs/showcase/compose-result.png" alt="Both characters composed into one scene" /></td>
</tr>
<tr>
<td align="center">Reference A</td>
<td align="center">Reference B</td>
<td align="center"><b>Composed:</b> both, in one new scene.</td>
</tr>
</table>

## Read a book, illustrate a scene, then fix what’s wrong

Upload a public-domain novel, ask the assistant to locate a chapter, and illustrate it. When the first watercolor of the Mad Tea-Party came back with **two** pocket watches, one more edit — *“keep a single watch, held to the Hatter’s ear”* — corrected the prop without redrawing the scene.

<table>
<tr>
<td width="25%"><img src="uncensia/docs/showcase/alice-01-tea-table.png" alt="Mad Tea-Party, illustrated from the book" /></td>
<td width="25%"><img src="uncensia/docs/showcase/alice-02-pocket-watch-v1.png" alt="First try: two watches" /></td>
<td width="25%"><img src="uncensia/docs/showcase/alice-02-pocket-watch.png" alt="After an edit: one watch" /></td>
<td width="25%"><img src="uncensia/docs/showcase/alice-03-leaving.png" alt="Alice leaving" /></td>
</tr>
<tr>
<td>Locate the scene, illustrate it.</td>
<td>First try: an extra watch.</td>
<td>One edit later: fixed.</td>
<td>Carry on to the next beat.</td>
</tr>
</table>

## Turn a still into a moving shot

Generate a character (here on a local ComfyUI GPU), relocate her with an image-to-image edit, then animate the still with image-to-video — all from the same library.

<p align="center">
<img src="uncensia/docs/showcase/03-departure.gif" alt="Image-to-video: the character's portrait animated" width="640" />
</p>

> Local ComfyUI (Lustify V10) for the portrait → Siray Seedream for the coastal edit → Siray Wan for the 4-second clip. [Full parameters, sources and hashes →](uncensia/docs/showcase/README.md)

---

## What it is

- **Self-hosted and private.** One person, one server. Your conversations, characters, files and creations live in a local SQLite database and folder you can back up. No telemetry.
- **Unrestricted.** No app-level content filter, safety LoRA, or blocked-word list. Uncensia focuses on quality; whatever policy applies is the one your chosen provider enforces.
- **Bring your own everything.** Chat, images, video, and web search each use *your* keys — cloud providers or a local ComfyUI. Nothing is metered by us because there is no “us” in the loop.
- **One integrated space, not five tabs.** Chat, a real tool-using agent, file/RAG search, long-term memory, image & video generation, roleplay, and visual continuity all share a single runtime and history.
- **Web *and* native iOS.** A React web app and a native SwiftUI iOS app talk to the same server over one wire contract — the same conversations, library and creations on your desk and in your pocket.

## More than chat — a story you can keep building

| What you want to do | How you continue in Uncensia |
|---|---|
| **Step into a book** | Upload the text, ask the assistant to find a scene, then adapt it or play a character. |
| **Bring your own characters and world** | Save a character, your persona, world and example dialogue — or import a character-card JSON. |
| **See what just happened** | Generate or reuse illustrations between passages, in the order the story unfolds. |
| **Keep a look you like** | Pin subject/scene/style references and edit a specific shot without losing the rest. |
| **Try another ending** | Edit, retry or branch the conversation; save deliverable versions and revise from feedback. |
| **Let it work while you’re away** | Schedule a task that keeps going on the server after you close the tab. |
| **Take it with you** | Open the same conversation in native iOS to read, chat, view images and create. |

<p align="center">
<img src="uncensia/docs/showcase/web-roleplay.zh-CN.jpg" alt="Roleplay in the web client" width="46%" />
&nbsp;
<img src="uncensia/docs/showcase/ios-alice-story.zh-CN.jpg" alt="An illustrated story in native iOS" width="24%" />
</p>

## A real agent, not just tool buttons

The assistant can read and write files, run commands in a sandboxed workspace (destructive actions pause for your approval), search the web and your library, remember facts across conversations, call MCP tools, and generate images and video — all as first-class tools in the same turn. It can carry a task forward on a schedule while the server stays online.

## Bring your own models — sensible defaults out of the box

A fresh install seeds a working set; add your keys in **Settings → Services** and switch anything.

| Role | Default model | Where |
|---|---|---|
| Chat | **GLM 5.3 Flash** | OpenRouter (your key) |
| Chat | **MuseSpark 1.3** | OpenCode Zen (free tier) |
| Image — generate / edit / compose | **Seedream 5.0 Pro** | Siray (your key) |
| Video | **Wan 3.0** | Siray (your key) |
| Image — local | **Lustify V10 Krea Turbo** | your own ComfyUI |

Any OpenAI-, Anthropic-, Gemini- or ComfyUI-compatible endpoint works too; pin the few models you want one tap away.

## Why Uncensia

There are excellent tools next door, but each stops short of the whole:

- **General chat clients** (LobeChat, Open WebUI, LibreChat, Cherry Studio) are great front-ends, but image/video is a bolt-on, they don’t do roleplay or continuity, and the mobile story is a PWA.
- **Roleplay front-ends** (SillyTavern, RisuAI) are deep at characters but have no real tool-using agent, treat generation as an extension, and have no polished native iOS.
- **Hosted companions** (Janitor, SpicyChat, Candy) are huge but hosted, filtered, and not yours.

Uncensia is the intersection none of them occupy: **a private, unrestricted, bring-your-own-model ChatGPT — with a real agent, illustrated writing and roleplay, image/video that stays visually consistent, on both web and native iOS.** It is deliberately single-user; that focus is the point.

## Quick start

Install **Node.js 24+**, then:

```bash
git clone https://github.com/s-JoL/Uncensia.git
cd Uncensia/uncensia
npm ci
npm run build
npm start
```

Open [127.0.0.1:8090](http://127.0.0.1:8090) and sign in with the access code printed in the server log. Add your keys in **Settings → Services**, then pick your chat and generation models.

- Cloud chat and media use your provider accounts and are billed by them.
- Local generation needs a separate ComfyUI install with its model files and workflow dependencies.
- Runtimes, weights, credentials and personal data are never in the repository.

[Configuration, updates, phone access and backup →](uncensia/docs/README.en.md)

## What it isn’t

- Not multi-tenant. One person owns the instance; projects organise material, they are not permission boundaries.
- Not a content filter. There is no app-level moderation; the services you connect enforce their own policies, and you are responsible for how you use it.
- Not a quality guarantee. Writing quality and visual consistency depend on the models you choose; edits like the watch fix above are normal.

Data defaults to `uncensia/data/`. Stop the server and back up the whole directory — including `master.key` — before upgrading. A conversation export is not a full backup.

## Development

```bash
cd uncensia
npm run typecheck
npm run audit
npm run build
```

Start with the [product scope](uncensia/docs/00-product.md) and the [documentation index](uncensia/docs/README.en.md). iOS builds in Xcode; real-provider generation is validated separately from the automated checks.

Built on [Pi](https://github.com/earendil-works/pi), [React](https://react.dev/), [Hono](https://hono.dev/), [ComfyUI](https://github.com/Comfy-Org/ComfyUI), and [MCP](https://modelcontextprotocol.io/).
