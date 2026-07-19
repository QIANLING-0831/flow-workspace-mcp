import assert from "node:assert/strict";
import test from "node:test";
import {
  identitiesFor,
  resolveMediaIdentities,
  selectNewMedia,
  type MediaSnapshot,
} from "../src/media-selection.js";

const ready = (index: number, ...keys: string[]): MediaSnapshot => ({ index, keys, ready: true });

test("new media is selected by identity, not DOM position", () => {
  const baseline = ["url:blob:jellyfish"];
  const current = [
    ready(0, "url:blob:rainy"),
    ready(1, "url:blob:jellyfish"),
  ];

  assert.deepEqual(selectNewMedia(current, baseline), [current[0]]);
});

test("a tracked generated asset still resolves after gallery reordering", () => {
  const generated = ready(1, "url:https://video.example/videoplayback?id=rainy&signature=one", "url-stable:https://video.example/videoplayback?id=rainy");
  const identities = identitiesFor([generated]);
  const reordered = [
    ready(0, "url:https://video.example/videoplayback?id=rainy&signature=two", "url-stable:https://video.example/videoplayback?id=rainy"),
    ready(1, "url:blob:jellyfish"),
  ];

  assert.deepEqual(resolveMediaIdentities(reordered, identities), [reordered[0]]);
});

test("ambiguous or missing identities fail closed", () => {
  const identity = [{ keys: ["url-stable:https://video.example/shared"] }];
  const ambiguous = [
    ready(0, "url-stable:https://video.example/shared"),
    ready(1, "url-stable:https://video.example/shared"),
  ];

  assert.equal(resolveMediaIdentities(ambiguous, identity), null);
  assert.equal(resolveMediaIdentities([ready(0, "url:blob:other")], identity), null);
});
