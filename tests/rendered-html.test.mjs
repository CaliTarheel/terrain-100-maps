import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_BOARD_HEIGHT_METERS,
  BASE_BOARD_HEX_COLUMNS,
  BASE_BOARD_HEX_ROWS,
  BASE_BOARD_WIDTH_METERS,
  boardFootprint,
  zoomForBoardFootprint,
} from "../app/board-layout.ts";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders public source and creator attribution", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Stephen G\. Rider/);
  assert.match(html, /mailto:rider\.sg@gmail\.com/);
  assert.match(html, /github\.com\/CaliTarheel\/terrain-100-maps/);
  assert.match(html, /MIT licensed/);
  assert.match(html, /Boards wide/);
  assert.match(html, /Boards high/);
});

test("MBT board mosaics scale from one through four boards on each axis", () => {
  const footprint = boardFootprint(4, 3);
  assert.equal(footprint.boardCount, 12);
  assert.equal(footprint.widthMeters, BASE_BOARD_WIDTH_METERS * 4);
  assert.equal(footprint.heightMeters, BASE_BOARD_HEIGHT_METERS * 3);
  assert.equal(footprint.totalHexColumns, BASE_BOARD_HEX_COLUMNS * 4);
  assert.equal(footprint.totalHexRows, BASE_BOARD_HEX_ROWS * 3);
  assert.ok(footprint.requestSpanMeters > footprint.widthMeters);
  assert.ok(zoomForBoardFootprint(50.5, footprint.widthMeters, footprint.heightMeters) < 15);
  assert.equal(boardFootprint(9, 0).boardCount, 4);
});
