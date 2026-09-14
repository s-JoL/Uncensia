# Creative guide

[Documentation](README.en.md) · [简体中文](guide.md)

Uncensia keeps chat, roleplay, book illustration, interleaved stories, and image and video creation in one chat-first flow. Configure working models in Settings first: a fresh install seeds OpenRouter GLM 5.3 Flash and OpenCode MuseSpark 1.3 (free) for chat, Siray Seedream 5.0 Pro Spicy for images (generate, edit, composite), Siray Wan 3.0 for video, and an optional local ComfyUI Lustify V10. Defaults include no keys or model weights: the chat model plans the work, and a generation model produces the pixels. A key for one hosted backend is enough to generate right away; local ComfyUI needs a separate install and the workflow's model files, so a chat key alone will not bring it online.

## Everything starts in chat

There is no mode to pick or command to run first. Open a new conversation and describe the goal — write, generate an image, read an uploaded passage, or start a roleplay. From here you can:

- Attach images or documents, or click "reference material" to bring in existing assets from the Library.
- "Stop" a run at any time, "steer" it to change the next turn, or queue the next instruction with "after the reply".
- "Edit" a message and regenerate, or open "versions and branches" to fork and compare directions.
- Leave "feedback" on a reply for the rest of the conversation to consider; "compact" a long conversation to condense its history.

Among chat models, one marked "sees images" (such as MuseSpark 1.3) can look at pictures and judge them; a "text only" one (such as GLM 5.3 Flash) plans faster but cannot see the frame.

## Roleplay and companionship

Open a new conversation and describe the roles. There is no separate RP mode to enable:

> I play a traveler arriving at the tea party; you play the Hatter. Keep the absurd tone, reply one short passage at a time, and leave my words and actions to me. Start as I open the garden gate.

For reusable setup, open "this conversation's settings" at the top right, enable "use saved story material", and fill in character, your identity, world, scene notes, writing style and example dialogue. You can import Character Card V2 JSON: preview first, then save. Import extracts text settings only; PNG cards, World Info activation and card-specific system overrides are not supported. For a quick try, a prompt alone is enough.

![Saved story material and the character-card import entry](showcase/web-story-settings.zh-CN.jpg)

Personal memory holds your own preferences and can be edited or deleted at any time; a fictional character's history belongs in story material or project documents, not personal memory.

## Read a book and illustrate a scene

The public-domain English text of [Alice's Adventures in Wonderland](https://www.gutenberg.org/ebooks/11) makes a recognizable starting point, and the tea party, rabbit hole and garden suit a continuous sequence. Modern translations and illustrations may carry separate rights; a public demo uses the original text or your own rewritten scene.

1. Upload a TXT, Markdown or supported document through the Library, or attach it in Chat.
2. For a longer work, create a project and add the book and related conversations, so the material is organized around it.
3. Reference the text in chat and ask the agent to locate the chapter before illustrating it.

> Read Chapter VII, A Mad Tea-Party, in the attached Alice's Adventures in Wonderland. First find the characters, props and actions in the text, then make three continuous watercolor illustrations: the whole tea table, a close-up of the Hatter and his watch, and Alice leaving. Keep the costumes, table layout and watercolor style consistent. Put a short scene line before each image, and check for anything missed after all three.

Quoting the text preserves where an image belongs; click an image to inspect, save or trace its source. Continue with a precise edit:

> Edit only the second image: bring the watch closer, keep the characters and palette, leave the other two unchanged.

A single success does not guarantee exact identity across images, so revise one at a time. See the [real production notes](showcase/README.md): the full reading, generation and local-edit process.

## Continue with interleaved prose and images

Continue in the same conversation, and be explicit about length, image count and placement:

> Continue with three short scenes from where the traveler sits down. Write about 150 words per scene, then generate and embed one matching illustration, then move to the next. Keep the tea-party characters and watercolor style, and do not collect all images at the end. Stop at a choice for me.

To reuse finished art, say "reuse these three; do not generate new images" and change only the text and its arrangement. The [real story capture](showcase/web-alice-story.jpg) uses the three final illustrations.

When prose falls short, edit and retry or create a branch. To deliver a draft, ask to save it as a deliverable; deliverables keep numbered versions, retain the old one after a revision, and are accepted or returned version by version.

## Generate, edit and composite images

Describe a frame in chat to generate it. To change an existing image, use it as the base and say what to change and what to keep; to composite several, say what each contributes and where. When you attach a reference, make its role clear — base to edit, subject reference, scene reference, style reference, or composite material. After zooming any image, choose "edit" (as the base) or "use as reference" directly.

> Use this portrait as a subject reference and generate a full-body image of her in a rainy night market, realistic 35mm look, keeping the hair and coat.

To hold one likeness across many images, enable "use pinned image references" in "this conversation's settings", write down only the appearance, wardrobe, environment and camera facts to keep long-term (the visual bible), and pin finished images as subject / scene / style references (up to three). Then say "continue from the last image" to reuse this state.

## Generate a short video

Video defaults to Siray Wan 3.0 and takes minutes rather than seconds. Generate from text, or name an image as the first frame to animate it:

> Use this station portrait as the first frame and make a 4-second, 720p, 16:9 clip: she turns toward the far end of the platform as the camera pushes in slowly, no audio.

## Studio and Library

**Studio** is for setting parameters yourself: choose the operation (generate image / edit image / video) and model, fill in the prompt and size, pick the base (Image 1) and any following material or references (from Image 2) in order, then submit and watch the queue. For editing, switch between "edit the base" and "composite multiple images". Parameters follow the model; closing the page or locking the screen leaves a job running in the queue, and it lands in "recent work" when done.

**Library** keeps documents, images, videos and notes. A work can be added back into chat, used as a base to edit, or opened to see its source and generation parameters.

## Projects, memory and deliverables

- **Projects** organize instructions, material and several conversations together; switch a conversation's project in "this conversation's settings" without changing the tools' filesystem working directory.
- **Personal memory** holds your long-term preferences and can be edited or deleted; fictional history belongs in story material or project documents.
- **Deliverables** are numbered snapshots of delivered work that keep their version history; a revised version needs your review again.

## Background tasks

While the server keeps running, closing the page or the phone app does not stop background work. You can schedule a one-time task, a task that works continuously toward a goal, or one that repeats at a fixed interval. They use the conversation's selected model, start when the conversation is idle, and return results here. Continuous and interval tasks can be viewed, paused, resumed or cancelled from the "tasks and deliverables" panel.

## Continue on iOS

The [iOS client](15-ios-native.md) connects to the same server. Sign in, open the original conversation, and continue reading, sending messages, viewing media, and using Studio and Library. On a physical phone, `127.0.0.1` means the phone itself; to reach a computer's server, use an address the phone can actually reach. See [the same story on iOS](showcase/ios-alice-story.zh-CN.jpg).
