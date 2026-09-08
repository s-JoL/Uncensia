/** Deterministic model-side contracts used by the native live UI suite. */
import { startOpenAiStub } from "./stub-openai.ts";
import { IOS_CI_VIDEO_BASE64 } from "./fixtures/ios-ci-video.ts";

const stub = await startOpenAiStub(0);

async function answer(text: string) {
  const response = await fetch(`${stub.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stub-chat", stream: false, messages: [{ role: "user", content: text }] }),
  });
  if (!response.ok) throw new Error(`stub returned ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content ?? "";
}

try {
  const video = Buffer.from(IOS_CI_VIDEO_BASE64, "base64");
  if (video.byteLength !== 2_228 || video.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error(`video fixture is not the expected MP4: ${video.byteLength} bytes`);
  }
  for (const box of ["moov", "mdat"]) {
    if (!video.includes(Buffer.from(box, "ascii"))) throw new Error(`video fixture has no ${box} box`);
  }

  const storyboard = await answer("写个五图卡点脚本");
  if (!storyboard.includes("五图卡点") || !storyboard.includes("别把五张图都塞满字")) {
    throw new Error("storyboard fixture lost its visible start or persisted tail marker");
  }
  if (storyboard.length < 1_000) throw new Error(`storyboard fixture is too short for suspend/resume: ${storyboard.length}`);

  const running = await answer("写一段足够长、分成五点的说明");
  if (running.length < 1_000) throw new Error(`running-composer fixture is too short: ${running.length}`);

  const queued = await answer("然后只回答：队列已到达");
  if (queued !== "队列已到达") throw new Error(`follow-up fixture answered ${JSON.stringify(queued)}`);

  console.log(
    `PASS iOS live fixture — MP4 ${video.byteLength} bytes, storyboard ${storyboard.length}, ` +
      `running ${running.length}, follow-up exact`,
  );
} finally {
  await stub.close();
}
