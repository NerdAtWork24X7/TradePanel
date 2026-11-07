import { test } from "node:test";
import assert from "node:assert/strict";
import { removeSvgComments } from "../scripts/svg-utils.mjs";

test("SVG comment removal does not reintroduce comment markers", () => {
  assert.equal(removeSvgComments("<<!--x-->!--y-->"), "");
});
