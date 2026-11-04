import assert from "node:assert/strict";
import test from "node:test";
import { isYouTubeVideoUrl } from "../src/discord/commands/music.js";

test("music accepts direct HTTPS YouTube video URLs only", () => {
  assert.equal(
    isYouTubeVideoUrl("https://www.youtube.com/watch?v=video123"),
    true,
  );
  assert.equal(isYouTubeVideoUrl("https://youtu.be/video123"), true);
  assert.equal(
    isYouTubeVideoUrl("https://youtube.com/playlist?list=playlist"),
    false,
  );
  assert.equal(isYouTubeVideoUrl("https://youtube.com/watch"), false);
  assert.equal(
    isYouTubeVideoUrl("https://youtube.com.evil.example/watch?v=x"),
    false,
  );
  assert.equal(isYouTubeVideoUrl("http://youtube.com/watch?v=x"), false);
});
