// Checks which origins the web app accepts bookmarklet data from (web/js/bookmarklet.js).
import assert from "node:assert/strict";
import test from "node:test";
import { isNeptunOrigin, bookmarkletHref } from "../web/js/bookmarklet.js";

test("accepts the listed Neptun host over HTTPS", () => {
  assert.equal(isNeptunOrigin("https://neptun.bme.hu"), true);
});

test("rejects look-alike, insecure and malformed origins", () => {
  for (const origin of [
    "https://neptun.example.com",
    "https://notneptun.com",
    "https://neptun.bme.hu.example.com",
    "https://evil-neptun.bme.hu",
    "https://sub.neptun.bme.hu",
    "http://neptun.bme.hu",
    "https://neptun.bme.hu:8443",
    "null",
    "",
  ]) {
    assert.equal(isNeptunOrigin(origin), false, origin);
  }
});

test("bookmarklet is a javascript: URL carrying the app address", () => {
  const href = bookmarkletHref("https://example.web.app/");
  assert.ok(href.startsWith("javascript:"));
  assert.ok(decodeURIComponent(href).includes('("https://example.web.app/")'));
});
