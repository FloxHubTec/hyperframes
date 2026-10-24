// @vitest-environment node
import { describe, expect, it } from "vitest";
import { htmlHasGsapCore } from "./gsapCoreScript";

const script = (src: string) => `<html><head><script src="${src}"></script></head></html>`;

describe("htmlHasGsapCore", () => {
  it.each([
    "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.js",
    "/api/vendor/npm/gsap@3.15.0/dist/gsap.min.js",
    "./vendor/gsap.min.js",
    "assets/gsap-3.14.2.min.js",
    "gsap.min.js?v=2",
  ])("finds GSAP core at %s", (src) => {
    expect(htmlHasGsapCore(script(src))).toBe(true);
  });

  it.each([
    "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/MotionPathPlugin.min.js",
    "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/CustomEase.min.js",
    "/api/vendor/npm/gsap@3.15.0/dist/MotionPathPlugin.min.js",
    "./vendor/gsap/ScrollTrigger.js",
  ])("does not treat the plugin %s as GSAP core", (src) => {
    expect(htmlHasGsapCore(script(src))).toBe(false);
  });

  it("reads core from a producer inlining marker, but not a plugin's", () => {
    const inlined = (src: string) => `<script>/* inlined: ${src} */\nvoid 0;</script>`;
    expect(htmlHasGsapCore(inlined("https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"))).toBe(
      true,
    );
    expect(
      htmlHasGsapCore(inlined("https://cdn.jsdelivr.net/npm/gsap@3/dist/MotionPathPlugin.min.js")),
    ).toBe(false);
  });

  it("reads core from its license banner, but not a plugin's", () => {
    const banner = (name: string) =>
      `<script>/*!\n * ${name} 3.15.0\n * https://gsap.com\n * @license Copyright 2026, GreenSock.\n */\n</script>`;
    expect(htmlHasGsapCore(banner("GSAP"))).toBe(true);
    expect(htmlHasGsapCore(banner("MotionPathPlugin"))).toBe(false);
  });

  it("ignores GSAP core inside a <template>", () => {
    const src = "https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js";
    expect(htmlHasGsapCore(`<template><script src="${src}"></script></template>`)).toBe(false);
  });
});
