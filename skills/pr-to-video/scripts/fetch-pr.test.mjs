import assert from "node:assert/strict";
import test from "node:test";

import { parsePrRef } from "./lib/pr-ref.mjs";

test("parses owner/repo#N", () => {
  assert.deepEqual(parsePrRef("DataLinkDC/dinky#4584"), {
    owner: "DataLinkDC",
    repo: "dinky",
    number: 4584,
  });
});

test("parses a full pull-request url", () => {
  assert.deepEqual(parsePrRef("https://github.com/DataLinkDC/dinky/pull/4584"), {
    owner: "DataLinkDC",
    repo: "dinky",
    number: 4584,
  });
});

test("parses a bare number", () => {
  assert.deepEqual(parsePrRef("4584"), { owner: null, repo: null, number: 4584 });
});

test("gives up on anything that names no pull request", () => {
  assert.deepEqual(parsePrRef("some-branch"), { owner: null, repo: null, number: null });
  assert.deepEqual(parsePrRef(""), { owner: null, repo: null, number: null });
});
